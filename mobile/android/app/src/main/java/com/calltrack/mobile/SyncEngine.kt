package com.calltrack.mobile

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.CallLog
import android.provider.MediaStore
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * All call-capture sync logic. Reads the call log and discovers recordings the
 * PHONE'S OWN dialer/recorder produced, then posts to the office server.
 *
 * The app never records audio itself. Recordings are discovered three ways:
 *   1. A user-picked SAF tree (prefs "safFolder") — most reliable on Pixel.
 *   2. MediaStore.Audio query (API 33+ READ_MEDIA_AUDIO) — second channel.
 *   3. A hardcoded OEM-folder allowlist via All-Files-Access (legacy).
 * No cloud — every byte goes only to the paired office server.
 */
object SyncEngine {
    private const val PREFS = "calltrack_sync"

    // OEM call-recording folders, probed in order via All-Files-Access.
    // First that exists is scanned; the SAF-granted tree (if any) is scanned too.
    private val RECORDING_DIRS = listOf(
        "Recordings/Call",                       // Samsung One UI
        "Call",                                  // older Samsung
        "MIUI/sound_recorder/call_rec",          // Xiaomi/Redmi/POCO
        "Recorder/call",                         // HyperOS
        "Music/Recordings/Call Recordings",      // realme / OPPO ColorOS
        "Record/Call",                           // vivo
        "Sounds/CallRecordings",                 // OnePlus
        "PhoneRecord",                           // generic
        "CallRecordings",
        // Pixel / Google Phone app + AOSP / generic defense-in-depth:
        "Recordings",                            // Pixel "Recorder"/Phone recordings root
        "Recordings/Call Recordings",            // Pixel Phone call-recording subfolder
        "Android/data/com.google.android.dialer/files/CallRecordings",
        "Music/Recordings",
        "Download/CallRecordings"
    )
    private val AUDIO_EXT = setOf("m4a", "mp3", "amr", "wav", "ogg", "aac", "3gp", "opus")

    // Substrings (lowercased) a path/name must contain for the MediaStore channel
    // to treat a file as a CALL recording. Keeps personal music/voice memos out.
    private val CALL_HINTS = listOf("call", "rec/call", "callrec", "call_rec", "call recording", "phonerecord")

    data class Config(val serverUrl: String, val token: String)

    fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun config(ctx: Context): Config? {
        val p = prefs(ctx)
        val url = p.getString("serverUrl", null) ?: return null
        val token = p.getString("token", null) ?: return null
        return Config(url.trimEnd('/'), token)
    }

    fun saveConfig(ctx: Context, serverUrl: String, token: String) {
        prefs(ctx).edit()
            .putString("serverUrl", serverUrl)
            .putString("token", token)
            .putLong("pairedAt", maxOf(prefs(ctx).getLong("pairedAt", 0L), System.currentTimeMillis()))
            .apply()
    }

    fun clearConfig(ctx: Context) = prefs(ctx).edit().clear().apply()

    fun lastSync(ctx: Context) = prefs(ctx).getLong("lastSyncMs", 0L)

    /** Returns {calls, recordings, errors[]}. Safe to call repeatedly. */
    fun sync(ctx: Context): JSONObject {
        val cfg = config(ctx) ?: return result(0, 0, listOf("Not paired"))
        val errors = mutableListOf<String>()
        var callCount = 0
        var recCount = 0

        val pairedAt = prefs(ctx).getLong("pairedAt", 0L)
        val sinceCalls = maxOf(prefs(ctx).getLong("lastCallTs", 0L), pairedAt)

        try {
            val calls = readCallLog(ctx, sinceCalls)
            if (calls.length() > 0) {
                postJson(cfg, "/api/sync/calls", JSONObject().put("calls", calls))
                callCount = calls.length()
                var maxTs = sinceCalls
                for (i in 0 until calls.length()) maxTs = maxOf(maxTs, calls.getJSONObject(i).getLong("call_log_ts"))
                prefs(ctx).edit().putLong("lastCallTs", maxTs).apply()
            }
        } catch (e: Exception) { errors.add("Calls: ${e.message}") }

        try {
            recCount = uploadRecordings(ctx, cfg, pairedAt)
        } catch (e: Exception) { errors.add("Recordings: ${e.message}") }

        prefs(ctx).edit().putLong("lastSyncMs", System.currentTimeMillis()).apply()
        return result(callCount, recCount, errors)
    }

    private fun readCallLog(ctx: Context, sinceMs: Long): JSONArray {
        val arr = JSONArray()
        val cols = arrayOf(
            CallLog.Calls.NUMBER, CallLog.Calls.TYPE,
            CallLog.Calls.DURATION, CallLog.Calls.DATE
        )
        ctx.contentResolver.query(
            CallLog.Calls.CONTENT_URI, cols,
            "${CallLog.Calls.DATE} > ?", arrayOf(sinceMs.toString()),
            "${CallLog.Calls.DATE} ASC"
        )?.use { c ->
            val ni = c.getColumnIndex(CallLog.Calls.NUMBER)
            val ti = c.getColumnIndex(CallLog.Calls.TYPE)
            val di = c.getColumnIndex(CallLog.Calls.DURATION)
            val dt = c.getColumnIndex(CallLog.Calls.DATE)
            while (c.moveToNext()) {
                val number = c.getString(ni) ?: continue
                val direction = when (c.getInt(ti)) {
                    CallLog.Calls.INCOMING_TYPE -> "incoming"
                    CallLog.Calls.OUTGOING_TYPE -> "outgoing"
                    else -> "missed"
                }
                arr.put(JSONObject()
                    .put("phone", number)
                    .put("direction", direction)
                    .put("duration_seconds", c.getInt(di))
                    .put("call_log_ts", c.getLong(dt)))
            }
        }
        return arr
    }

    // ---- Discovery channel A: a user-picked SAF tree ----
    // Returns the DocumentFile tree root the user granted (or null).
    fun safTree(ctx: Context): DocumentFile? {
        val uriStr = prefs(ctx).getString("safFolder", null) ?: return null
        val uri = Uri.parse(uriStr)
        return try { DocumentFile.fromTreeUri(ctx, uri) } catch (_: Exception) { null }
    }

    // ---- Discovery channel C: legacy OEM folders via All-Files-Access ----
    fun recordingFolders(ctx: Context): List<File> {
        val ext = android.os.Environment.getExternalStorageDirectory()
        return RECORDING_DIRS.map { File(ext, it) }.filter { it.isDirectory }
    }

    /**
     * A discovered recording, abstracted over its source so dedupe + upload
     * are identical for File, SAF DocumentFile and MediaStore rows.
     * ledgerKey preserves the original "name:length" semantics.
     */
    private data class Rec(
        val name: String,
        val length: Long,
        val lastModified: Long,
        val open: () -> InputStream?
    ) {
        val ledgerKey get() = "$name:$length"
    }

    private fun uploadRecordings(ctx: Context, cfg: Config, pairedAt: Long): Int {
        val ledger = prefs(ctx).getStringSet("uploaded", emptySet())!!.toMutableSet()
        var count = 0

        val recs = mutableListOf<Rec>()
        // Channel A — SAF tree (recursive).
        safTree(ctx)?.let { collectFromSaf(ctx, it, recs) }
        // Channel C — legacy File folders.
        for (dir in recordingFolders(ctx)) collectFromFiles(dir, recs)
        // Channel B — MediaStore.Audio (API 33+ READ_MEDIA_AUDIO or All-Files).
        collectFromMediaStore(ctx, pairedAt, recs)

        // Dedupe across channels on the ledger key (name:length), upload new ones.
        val seenThisRun = HashSet<String>()
        for (r in recs) {
            if (r.lastModified < pairedAt) continue
            val key = r.ledgerKey
            if (!seenThisRun.add(key)) continue        // same file via 2 channels
            if (ledger.contains(key)) continue
            try {
                val stream = r.open() ?: continue
                uploadOne(cfg, r, stream)
                ledger.add(key)
                count++
            } catch (_: Exception) { /* retry next run */ }
        }
        prefs(ctx).edit().putStringSet("uploaded", ledger).apply()
        return count
    }

    private fun collectFromFiles(dir: File, out: MutableList<Rec>) {
        val files = dir.listFiles() ?: return
        for (f in files) {
            if (!f.isFile) continue
            if (f.extension.lowercase() !in AUDIO_EXT) continue
            out.add(Rec(f.name, f.length(), f.lastModified()) { f.inputStream() })
        }
    }

    private fun collectFromSaf(ctx: Context, dir: DocumentFile, out: MutableList<Rec>) {
        val children = try { dir.listFiles() } catch (_: Exception) { return }
        for (df in children) {
            if (df.isDirectory) { collectFromSaf(ctx, df, out); continue } // recurse one folder deep is enough, but full recursion is safe
            val name = df.name ?: continue
            val ext = name.substringAfterLast('.', "").lowercase()
            if (ext !in AUDIO_EXT) continue
            out.add(Rec(name, df.length(), df.lastModified()) {
                try { ctx.contentResolver.openInputStream(df.uri) } catch (_: Exception) { null }
            })
        }
    }

    private fun collectFromMediaStore(ctx: Context, pairedAt: Long, out: MutableList<Rec>) {
        val collection = if (Build.VERSION.SDK_INT >= 29)
            MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        else
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI

        val projection = arrayOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.DATE_MODIFIED,   // seconds
            MediaStore.Audio.Media.RELATIVE_PATH    // API 29+
        )
        // pairedAt cutoff (DATE_MODIFIED is in SECONDS).
        val sinceSec = (pairedAt / 1000L)
        val selection = "${MediaStore.Audio.Media.DATE_MODIFIED} >= ?"
        val args = arrayOf(sinceSec.toString())

        try {
            ctx.contentResolver.query(collection, projection, selection, args,
                "${MediaStore.Audio.Media.DATE_MODIFIED} ASC")?.use { c ->
                val idI = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
                val nameI = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
                val sizeI = c.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE)
                val modI = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_MODIFIED)
                val pathI = c.getColumnIndex(MediaStore.Audio.Media.RELATIVE_PATH)
                while (c.moveToNext()) {
                    val name = c.getString(nameI) ?: continue
                    val ext = name.substringAfterLast('.', "").lowercase()
                    if (ext !in AUDIO_EXT) continue
                    val relPath = if (pathI >= 0) (c.getString(pathI) ?: "") else ""
                    // Tight filter: name OR folder must look like a CALL recording.
                    val hay = "$relPath/$name".lowercase()
                    if (CALL_HINTS.none { hay.contains(it) }) continue
                    val size = c.getLong(sizeI)
                    val modMs = c.getLong(modI) * 1000L
                    val id = c.getLong(idI)
                    val itemUri = Uri.withAppendedPath(collection, id.toString())
                    out.add(Rec(name, size, modMs) {
                        try { ctx.contentResolver.openInputStream(itemUri) } catch (_: Exception) { null }
                    })
                }
            }
        } catch (_: SecurityException) { /* READ_MEDIA_AUDIO not granted yet */ }
        catch (_: Exception) { /* ignore — other channels still run */ }
    }

    private fun durationOf(stream: InputStream?): Int? {
        // MediaMetadataRetriever needs a path/FD/uri, not a generic stream; for
        // the duration metadata we re-open via a temp not needed — callers that
        // can supply a path use durationOfPath. For stream sources we skip.
        return null
    }

    // ---- HTTP (no third-party libs; plain HttpURLConnection) ----
    private fun postJson(cfg: Config, path: String, body: JSONObject): String {
        val conn = (URL(cfg.serverUrl + path).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("Authorization", "Bearer ${cfg.token}")
            setRequestProperty("Content-Type", "application/json")
            doOutput = true
            connectTimeout = 10000
            readTimeout = 30000
        }
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        val code = conn.responseCode
        val resp = (if (code in 200..299) conn.inputStream else conn.errorStream)
            ?.bufferedReader()?.readText() ?: ""
        conn.disconnect()
        if (code !in 200..299) throw RuntimeException("HTTP $code: $resp")
        return resp
    }

    private fun uploadOne(cfg: Config, rec: Rec, stream: InputStream) {
        val boundary = "----calltrack${System.nanoTime()}"
        val conn = (URL(cfg.serverUrl + "/api/sync/recordings").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("Authorization", "Bearer ${cfg.token}")
            setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            doOutput = true
            connectTimeout = 10000
            readTimeout = 60000
        }
        conn.outputStream.use { out ->
            fun field(name: String, value: String) {
                out.write("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n".toByteArray())
            }
            field("filename", rec.name)
            field("last_modified_ms", rec.lastModified.toString())
            // duration is computed server-side now (stream sources have no path);
            // server can probe with ffprobe. If you must send it, see note below.
            out.write(("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"${rec.name}\"\r\n" +
                "Content-Type: application/octet-stream\r\n\r\n").toByteArray())
            stream.use { it.copyTo(out) }
            out.write("\r\n--$boundary--\r\n".toByteArray())
        }
        val code = conn.responseCode
        conn.disconnect()
        if (code !in 200..299) throw RuntimeException("upload HTTP $code")
    }

    private fun result(calls: Int, recs: Int, errors: List<String>) = JSONObject()
        .put("calls", calls).put("recordings", recs)
        .put("errors", JSONArray(errors))

    fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
