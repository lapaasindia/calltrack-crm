package com.calltrack.mobile

import android.content.Context
import android.media.MediaMetadataRetriever
import android.os.Build
import android.provider.CallLog
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * All call-capture sync logic. Reads the call log and the OEM dialer's
 * recordings folder, posts to the office server. Runnable from the UI
 * (CallSyncPlugin) or a background WorkManager job. No cloud — every byte
 * goes only to the paired office server.
 */
object SyncEngine {
    private const val PREFS = "calltrack_sync"

    // OEM call-recording folders, probed in order. The first that exists is
    // watched; an SAF-granted folder (if any) is added on top.
    private val RECORDING_DIRS = listOf(
        "Recordings/Call",                       // Samsung One UI
        "Call",                                  // older Samsung
        "MIUI/sound_recorder/call_rec",          // Xiaomi/Redmi/POCO
        "Recorder/call",                         // HyperOS
        "Music/Recordings/Call Recordings",      // realme / OPPO ColorOS
        "Record/Call",                           // vivo
        "Sounds/CallRecordings",                 // OnePlus
        "PhoneRecord",                           // generic
        "CallRecordings"
    )
    private val AUDIO_EXT = setOf("m4a", "mp3", "amr", "wav", "ogg", "aac", "3gp", "opus")

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

        // Only sync activity from after pairing — never vacuum up old personal
        // calls/recordings on first run.
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

    fun recordingFolders(ctx: Context): List<File> {
        val ext = android.os.Environment.getExternalStorageDirectory()
        val found = RECORDING_DIRS.map { File(ext, it) }.filter { it.isDirectory }.toMutableList()
        prefs(ctx).getString("safFolder", null)?.let { found.add(File(it)) }
        return found
    }

    private fun uploadRecordings(ctx: Context, cfg: Config, pairedAt: Long): Int {
        val ledger = prefs(ctx).getStringSet("uploaded", emptySet())!!.toMutableSet()
        var count = 0
        for (dir in recordingFolders(ctx)) {
            val files = dir.listFiles() ?: continue
            for (f in files) {
                if (!f.isFile) continue
                val ext = f.extension.lowercase()
                if (ext !in AUDIO_EXT) continue
                if (f.lastModified() < pairedAt) continue
                val key = "${f.name}:${f.length()}"
                if (ledger.contains(key)) continue
                try {
                    uploadOne(cfg, f)
                    ledger.add(key)
                    count++
                } catch (_: Exception) { /* retry next run */ }
            }
        }
        prefs(ctx).edit().putStringSet("uploaded", ledger).apply()
        return count
    }

    private fun durationOf(f: File): Int? = try {
        val mmr = MediaMetadataRetriever()
        mmr.setDataSource(f.absolutePath)
        val ms = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLong()
        mmr.release()
        ms?.let { (it / 1000).toInt() }
    } catch (_: Exception) { null }

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

    private fun uploadOne(cfg: Config, f: File) {
        val boundary = "----calltrack${System.nanoTime()}"
        val conn = (URL(cfg.serverUrl + "/api/sync/recordings").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("Authorization", "Bearer ${cfg.token}")
            setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            doOutput = true
            connectTimeout = 10000
            readTimeout = 60000
        }
        val dur = durationOf(f)
        conn.outputStream.use { out ->
            fun field(name: String, value: String) {
                out.write("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n".toByteArray())
            }
            field("filename", f.name)
            field("last_modified_ms", f.lastModified().toString())
            if (dur != null) field("duration_seconds", dur.toString())
            out.write(("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"${f.name}\"\r\n" +
                "Content-Type: application/octet-stream\r\n\r\n").toByteArray())
            f.inputStream().use { it.copyTo(out) }
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
