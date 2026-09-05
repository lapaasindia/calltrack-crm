package com.calltrack.mobile

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.provider.CallLog
import android.provider.MediaStore
import androidx.documentfile.provider.DocumentFile
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import java.security.MessageDigest
import java.util.concurrent.locks.ReentrantLock

/**
 * All call-capture sync logic. Reads the call log and discovers recordings the
 * PHONE'S OWN dialer/recorder produced, then posts to the office server.
 *
 * The app never records audio itself. Recordings are discovered three ways:
 *   1. A user-picked SAF tree (prefs "safFolder") — most reliable on Pixel.
 *   2. MediaStore.Audio query (API 33+ READ_MEDIA_AUDIO) — second channel.
 *   3. Well-known OEM folders via the File API (only what scoped storage lets
 *      us see — media files the app can read; degrades to empty).
 * No cloud — every byte goes only to the paired office server.
 *
 * Watermark discipline (MOB-1/MOB-5/MOB-12/MOB-23):
 *   - `pairedAt` is written ONCE, at the first pairing, and never moved by a
 *     later configure() from app boot. Re-pairing after a disconnect resets it
 *     (clearConfig wipes everything).
 *   - The call-log cursor `lastCallTs` only advances to the newest row the
 *     server ACCEPTED (attached / captured / duplicate / ignored / permanently
 *     invalid), per successful ≤200-row chunk. Never on failure, never past a
 *     row the server rejected as a future timestamp.
 *   - Every catch-up window is bounded to the last 30 days.
 *   - sync() is guarded by a lock: overlapping callers get {busy:true}.
 *   - The recordings ledger is written per file, so a crash mid-run never
 *     re-uploads what already landed.
 */
object SyncEngine {
    private const val PREFS = "calltrack_sync"
    private const val SECURE_PREFS = "calltrack_secure"
    private const val SECURE_FALLBACK_PREFS = "calltrack_secure_plain"

    const val CATCHUP_WINDOW_MS = 30L * 24 * 3600 * 1000
    const val CALL_BATCH = 200
    const val MAX_UPLOAD_BYTES = 80L * 1024 * 1024
    // A file whose mtime is within this window may still be being written.
    const val STABLE_AGE_MS = 30_000L
    const val STABILITY_SETTLE_MS = 2_000L
    const val MAX_IO_ATTEMPTS = 8
    const val LEDGER_MAX = 5000
    const val SKIPPED_MAX = 1000
    const val DISCONNECTED_MSG =
        "This phone was disconnected or the pairing expired — scan the QR again"

    // Well-known OEM call-recording folders (scoped storage permitting).
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
        "Recordings",                            // Pixel "Recorder"/Phone recordings root
        "Recordings/Call Recordings",            // Pixel Phone call-recording subfolder
        "Music/Recordings",
        "Download/CallRecordings"
    )
    private val AUDIO_EXT = setOf("m4a", "mp3", "amr", "wav", "ogg", "aac", "3gp", "opus")

    // Substrings (lowercased) a folder path or file name must contain for ANY
    // channel to treat a file as a CALL recording (MOB-10). Keeps songs, voice
    // memos and WhatsApp notes out even if the user picks a broad SAF tree.
    private val CALL_HINTS = listOf(
        "call", "callrec", "call_rec", "call recording", "phonerecord", "phone_record", "rec/call"
    )

    data class Config(val serverUrl: String, val token: String)

    class AuthException(msg: String) : RuntimeException(msg)
    class HttpException(val code: Int, val body: String) : RuntimeException("HTTP $code${if (body.isBlank()) "" else ": $body"}")

    private val lock = ReentrantLock()

    fun prefs(ctx: Context): SharedPreferences =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ---- Token storage (MOB-13): Keystore-backed EncryptedSharedPreferences,
    // with a plain-prefs fallback only if the Keystore is unusable on this
    // device (some ROMs corrupt it). tokenStorage(ctx) reports which landed.
    @Volatile private var secure: SharedPreferences? = null
    @Volatile private var secureIsEncrypted = false

    fun securePrefs(ctx: Context): SharedPreferences {
        secure?.let { return it }
        synchronized(this) {
            secure?.let { return it }
            val app = ctx.applicationContext
            val sp = try {
                val mk = MasterKey.Builder(app)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build()
                val esp = EncryptedSharedPreferences.create(
                    app, SECURE_PREFS, mk,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
                )
                secureIsEncrypted = true
                esp
            } catch (_: Throwable) {
                secureIsEncrypted = false
                app.getSharedPreferences(SECURE_FALLBACK_PREFS, Context.MODE_PRIVATE)
            }
            secure = sp
            return sp
        }
    }

    fun tokenStorage(ctx: Context): String {
        securePrefs(ctx)
        return if (secureIsEncrypted) "keystore" else "plain"
    }

    fun token(ctx: Context): String? {
        val sp = securePrefs(ctx)
        sp.getString("token", null)?.let { return it }
        // One-time migration from builds that kept the token in plain prefs.
        val legacy = prefs(ctx).getString("token", null) ?: return null
        sp.edit().putString("token", legacy).apply()
        prefs(ctx).edit().remove("token").apply()
        return legacy
    }

    fun config(ctx: Context): Config? {
        val url = prefs(ctx).getString("serverUrl", null) ?: return null
        val token = token(ctx) ?: return null
        return Config(url.trimEnd('/'), token)
    }

    /** Called at pairing AND (harmlessly) at app boot. Never moves pairedAt (MOB-1). */
    fun saveConfig(ctx: Context, serverUrl: String, token: String) {
        val p = prefs(ctx)
        val ed = p.edit()
            .putString("serverUrl", serverUrl.trimEnd('/'))
            .remove("token")
            .remove("disconnectedReason")
        if (!p.contains("pairedAt")) ed.putLong("pairedAt", System.currentTimeMillis())
        ed.apply()
        securePrefs(ctx).edit().putString("token", token).apply()
    }

    /** Forget the pairing: token, cursors, ledger; stop the FGS and all work. */
    fun clearConfig(ctx: Context) {
        try { CallObserverService.stop(ctx) } catch (_: Throwable) {}
        try {
            val wm = WorkManager.getInstance(ctx.applicationContext)
            wm.cancelUniqueWork(CallSyncPlugin.PERIODIC_WORK)
            wm.cancelUniqueWork(CallObserverService.EXPEDITED_WORK)
        } catch (_: Throwable) {}
        try { securePrefs(ctx).edit().clear().apply() } catch (_: Throwable) {}
        prefs(ctx).edit().clear().apply()
    }

    /** Server said 401: the token was revoked or expired. Disconnect locally. */
    fun onUnauthorized(ctx: Context) {
        clearConfig(ctx)
        prefs(ctx).edit().putString("disconnectedReason", DISCONNECTED_MSG).apply()
    }

    fun lastSync(ctx: Context) = prefs(ctx).getLong("lastSyncMs", 0L)
    fun lastSuccess(ctx: Context) = prefs(ctx).getLong("lastSuccessMs", 0L)
    fun lastError(ctx: Context): String? = prefs(ctx).getString("lastError", null)
    fun pendingUploads(ctx: Context) = prefs(ctx).getInt("pendingUploads", 0)

    /**
     * Returns {calls, recordings, errors[], busy?, unpaired?}. Safe to call
     * repeatedly and from any thread; concurrent callers get busy=true.
     */
    fun sync(ctx: Context): JSONObject {
        if (!lock.tryLock()) return result(0, 0, emptyList()).put("busy", true)
        try {
            return doSync(ctx.applicationContext)
        } finally {
            lock.unlock()
        }
    }

    private fun doSync(ctx: Context): JSONObject {
        val cfg = config(ctx) ?: return result(0, 0, listOf("Not paired")).put("unpaired", true)
        val p = prefs(ctx)
        val errors = mutableListOf<String>()
        var callCount = 0
        var recCount = 0
        var unpaired = false

        val now = System.currentTimeMillis()
        val pairedAt = p.getLong("pairedAt", now)
        // First catch-up (and any long outage) is bounded to 30 days.
        val floor = maxOf(pairedAt, now - CATCHUP_WINDOW_MS)
        val sinceCalls = maxOf(p.getLong("lastCallTs", 0L), floor)

        try {
            callCount = syncCalls(ctx, cfg, sinceCalls, errors)
        } catch (_: AuthException) {
            unpaired = true
        } catch (e: Exception) {
            errors.add("Calls: ${describe(e)}")
        }

        if (!unpaired) {
            try {
                recCount = uploadRecordings(ctx, cfg, floor, errors)
            } catch (_: AuthException) {
                unpaired = true
            } catch (e: Exception) {
                errors.add("Recordings: ${describe(e)}")
            }
        }

        // Nothing was sent this run → nothing above could have noticed a dead
        // server or a revoked token. One cheap GET keeps "Synced 0 calls" honest
        // (EMU-3) and lets a background run detect a revoke (EMU-4).
        if (!unpaired && errors.isEmpty() && callCount == 0 && recCount == 0) {
            try {
                ping(cfg)
            } catch (_: AuthException) {
                unpaired = true
            } catch (e: Exception) {
                errors.add("Server unreachable: ${describe(e)}")
            }
        }

        if (unpaired) {
            onUnauthorized(ctx)
            return result(callCount, recCount, listOf(DISCONNECTED_MSG)).put("unpaired", true)
        }

        val ed = p.edit().putLong("lastSyncMs", now)
        if (errors.isEmpty()) ed.putLong("lastSuccessMs", now).remove("lastError")
        else ed.putString("lastError", errors.joinToString(" · "))
        ed.apply()
        return result(callCount, recCount, errors)
    }

    // ---------------------------------------------------------------- calls

    /** Posts the backlog in ≤200-row chunks, advancing the cursor per accepted chunk. */
    private fun syncCalls(ctx: Context, cfg: Config, since: Long, errors: MutableList<String>): Int {
        val calls = readCallLog(ctx, since)
        if (calls.isEmpty()) return 0
        val p = prefs(ctx)
        var accepted = 0
        var idx = 0
        var batch = CALL_BATCH
        var watermark = since

        while (idx < calls.size) {
            val end = minOf(idx + batch, calls.size)
            val chunk = calls.subList(idx, end)
            val resp = try {
                postJson(cfg, "/api/sync/calls", JSONObject().put("calls", JSONArray(chunk)))
            } catch (e: HttpException) {
                // A 400 is usually "batch too large" on an older server — halve and retry.
                if (e.code == 400 && batch > 1) { batch = maxOf(1, batch / 2); continue }
                throw e
            }
            val results = try { JSONObject(resp).optJSONArray("results") } catch (_: Exception) { null }

            var chunkMax = watermark
            var haltReason: String? = null
            val deviceNow = System.currentTimeMillis()
            for (i in chunk.indices) {
                val ts = chunk[i].getLong("call_log_ts")
                val r = results?.optJSONObject(i)
                val status = r?.optString("status") ?: "attached"
                val reason = r?.optString("reason") ?: ""
                if (status == "invalid" && reason == "bad_timestamp" && ts > deviceNow) {
                    // Future-dated on the server's clock: retry once time catches
                    // up (ancient rows are permanently invalid and skipped).
                    haltReason = "a call has a future timestamp — check the phone's clock"
                    break
                }
                chunkMax = maxOf(chunkMax, ts)
                if (status == "attached" || status == "captured") accepted++
            }
            if (chunkMax > watermark) {
                watermark = chunkMax
                p.edit().putLong("lastCallTs", watermark).apply()
            }
            if (haltReason != null) { errors.add("Calls: $haltReason"); break }
            idx = end
        }
        return accepted
    }

    private fun readCallLog(ctx: Context, sinceMs: Long): List<JSONObject> {
        val out = ArrayList<JSONObject>()
        val cols = arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DURATION, CallLog.Calls.DATE)
        val tooFuture = System.currentTimeMillis() + 2L * 86_400_000
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
                val ts = c.getLong(dt)
                if (ts > tooFuture) continue // broken clock — the server would reject it forever
                val direction = when (c.getInt(ti)) {
                    CallLog.Calls.INCOMING_TYPE -> "incoming"
                    CallLog.Calls.OUTGOING_TYPE -> "outgoing"
                    CallLog.Calls.MISSED_TYPE, CallLog.Calls.REJECTED_TYPE -> "missed"
                    CallLog.Calls.ANSWERED_EXTERNALLY_TYPE -> "incoming"
                    else -> continue // BLOCKED / VOICEMAIL are not calls the team made (MOB-23)
                }
                out.add(JSONObject()
                    .put("phone", number)
                    .put("direction", direction)
                    .put("duration_seconds", c.getInt(di))
                    .put("call_log_ts", ts))
            }
        }
        return out
    }

    // ----------------------------------------------------------- recordings

    /**
     * A discovered recording, abstracted over its source so dedupe + upload
     * are identical for File, SAF DocumentFile and MediaStore rows.
     * `hay` is "folder/name" lowercased for the CALL_HINTS filter.
     */
    private class Rec(
        val name: String,
        val length: Long,
        val lastModified: Long,
        val hay: String,
        val open: () -> InputStream?,
        val currentLength: () -> Long?
    ) {
        val ledgerKey get() = "$name:$length:$lastModified"
        val legacyKey get() = "$name:$length"
    }

    /** Ordered, pruned ledgers persisted as JSON (the old StringSet is migrated). */
    private class Ledger(private val p: SharedPreferences) {
        val uploaded = LinkedHashSet<String>()
        val skipped = LinkedHashMap<String, String>()
        val attempts = HashMap<String, Int>()

        init {
            p.getStringSet("uploaded", null)?.let { uploaded.addAll(it) }
            p.getString("uploadedLedger", null)?.let {
                try { val a = JSONArray(it); for (i in 0 until a.length()) uploaded.add(a.getString(i)) } catch (_: Exception) {}
            }
            p.getString("skippedLedger", null)?.let {
                try { val o = JSONObject(it); for (k in o.keys()) skipped[k] = o.optString(k) } catch (_: Exception) {}
            }
            p.getString("uploadAttempts", null)?.let {
                try { val o = JSONObject(it); for (k in o.keys()) attempts[k] = o.optInt(k) } catch (_: Exception) {}
            }
        }

        fun isDone(r: Rec) =
            uploaded.contains(r.ledgerKey) || uploaded.contains(r.legacyKey) || skipped.containsKey(r.ledgerKey)

        fun markUploaded(key: String) {
            uploaded.remove(key); uploaded.add(key); attempts.remove(key); save()
        }

        fun markSkipped(key: String, reason: String) {
            skipped.remove(key); skipped[key] = reason; attempts.remove(key); save()
        }

        fun bump(key: String): Int {
            val n = (attempts[key] ?: 0) + 1
            attempts[key] = n; save(); return n
        }

        private fun save() {
            while (uploaded.size > LEDGER_MAX) uploaded.remove(uploaded.first())
            while (skipped.size > SKIPPED_MAX) skipped.remove(skipped.keys.first())
            p.edit()
                .remove("uploaded")
                .putString("uploadedLedger", JSONArray(uploaded.toList()).toString())
                .putString("skippedLedger", JSONObject(skipped as Map<*, *>).toString())
                .putString("uploadAttempts", JSONObject(attempts as Map<*, *>).toString())
                .apply()
        }
    }

    private fun uploadRecordings(ctx: Context, cfg: Config, floor: Long, errors: MutableList<String>): Int {
        val ledger = Ledger(prefs(ctx))
        val recs = mutableListOf<Rec>()
        safTree(ctx)?.let { collectFromSaf(ctx, it, it.name ?: "", 0, recs) }
        for (dir in recordingFolders(ctx)) collectFromFiles(ctx, dir, recs)
        collectFromMediaStore(ctx, floor, recs)

        val now = System.currentTimeMillis()
        val seen = HashSet<String>()
        // Same file seen through two channels (File mtime in ms vs MediaStore in
        // whole seconds) dedupes on name:length within a run.
        val candidates = recs.filter { r ->
            r.lastModified >= floor &&
                CALL_HINTS.any { r.hay.contains(it) } &&
                seen.add(r.legacyKey) &&
                !ledger.isDone(r)
        }

        // MOB-15: never upload a file that may still be being written.
        val fresh = candidates.filter { kotlin.math.abs(now - it.lastModified) < STABLE_AGE_MS }
        var stable = candidates.filter { kotlin.math.abs(now - it.lastModified) >= STABLE_AGE_MS }
        if (stable.isNotEmpty()) {
            val first = stable.map { it.currentLength() }
            try { Thread.sleep(STABILITY_SETTLE_MS) } catch (_: InterruptedException) {}
            stable = stable.filterIndexed { i, r -> first[i] != null && first[i] == r.length && first[i] == r.currentLength() }
        }
        var pending = candidates.size - stable.size
        var count = 0
        var abort: String? = null
        var localErr: String? = null

        for (r in stable) {
            if (abort != null) { pending++; continue }
            val key = r.ledgerKey
            if (r.length > MAX_UPLOAD_BYTES) {
                ledger.markSkipped(key, "too large")
                errors.add("Recordings: ${r.name} is ${r.length / 1048576} MB — over the 80 MB limit, not uploaded")
                continue
            }
            try {
                // Pre-check by content hash so a re-discovered file costs a read, not an upload.
                val sha = try { sha256Of(r) } catch (_: IOException) { null }
                if (sha != null && existsOnServer(cfg, sha)) { ledger.markUploaded(key); continue }
                val stream = r.open() ?: throw IOException("cannot open ${r.name}")
                uploadOne(cfg, r, stream)
                ledger.markUploaded(key)
                count++
            } catch (e: AuthException) {
                throw e
            } catch (e: HttpException) {
                when (e.code) {
                    429, 507, in 500..599 -> { abort = describeHttp(e); pending++ } // temporary: retry next run
                    else -> {                                                       // 400/413/415…: permanent
                        ledger.markSkipped(key, "server rejected: ${e.code}")
                        errors.add("Recordings: ${r.name} rejected by the server (${describeHttp(e)})")
                    }
                }
            } catch (e: Exception) {
                if (isNetworkError(e)) { abort = describe(e); pending++ }
                else {
                    val n = ledger.bump(key)
                    if (n >= MAX_IO_ATTEMPTS) {
                        ledger.markSkipped(key, "gave up after $n attempts: ${describe(e)}")
                        errors.add("Recordings: gave up on ${r.name} after $n attempts (${describe(e)})")
                    } else { pending++; localErr = "${r.name}: ${describe(e)}" }
                }
            }
        }
        prefs(ctx).edit().putInt("pendingUploads", pending).apply()
        if (abort != null) errors.add("Recordings: $abort")
        else if (localErr != null) errors.add("Recordings: $localErr")
        return count
    }

    // ---- Discovery channel A: a user-picked SAF tree ----
    fun safTree(ctx: Context): DocumentFile? {
        val uriStr = prefs(ctx).getString("safFolder", null) ?: return null
        return try { DocumentFile.fromTreeUri(ctx, Uri.parse(uriStr)) } catch (_: Exception) { null }
    }

    // ---- Discovery channel C: well-known OEM folders via the File API ----
    fun recordingFolders(ctx: Context): List<File> {
        val ext = android.os.Environment.getExternalStorageDirectory()
        return RECORDING_DIRS.map { File(ext, it) }.filter { it.isDirectory }
    }

    private fun collectFromFiles(ctx: Context, dir: File, out: MutableList<Rec>) {
        val files = try { dir.listFiles() } catch (_: Exception) { null } ?: return
        val root = android.os.Environment.getExternalStorageDirectory().absolutePath
        val rel = dir.absolutePath.removePrefix(root).trim('/')
        for (f in files) {
            if (!f.isFile) continue
            if (f.extension.lowercase() !in AUDIO_EXT) continue
            out.add(Rec(f.name, f.length(), f.lastModified(), "$rel/${f.name}".lowercase(),
                { f.inputStream() }, { if (f.exists()) f.length() else null }))
        }
    }

    // Depth-capped (MOB-10): root=0 → its sub-folders (1) → theirs (2). No deeper.
    private fun collectFromSaf(ctx: Context, dir: DocumentFile, path: String, depth: Int, out: MutableList<Rec>) {
        val children = try { dir.listFiles() } catch (_: Exception) { return }
        for (df in children) {
            val name = df.name ?: continue
            if (df.isDirectory) {
                if (depth < 2) collectFromSaf(ctx, df, "$path/$name", depth + 1, out)
                continue
            }
            val ext = name.substringAfterLast('.', "").lowercase()
            if (ext !in AUDIO_EXT) continue
            out.add(Rec(name, df.length(), df.lastModified(), "$path/$name".lowercase(),
                { try { ctx.contentResolver.openInputStream(df.uri) } catch (_: Exception) { null } },
                { try { df.length() } catch (_: Exception) { null } }))
        }
    }

    private fun collectFromMediaStore(ctx: Context, floor: Long, out: MutableList<Rec>) {
        val collection = if (Build.VERSION.SDK_INT >= 29)
            MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        else
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI

        // RELATIVE_PATH exists from API 29; older builds expose the full DATA path (MOB-23).
        @Suppress("DEPRECATION")
        val pathCol = if (Build.VERSION.SDK_INT >= 29) MediaStore.Audio.Media.RELATIVE_PATH else MediaStore.Audio.Media.DATA
        val projection = arrayOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.DATE_MODIFIED,   // seconds
            pathCol
        )
        val selection = "${MediaStore.Audio.Media.DATE_MODIFIED} >= ?"
        val args = arrayOf((floor / 1000L).toString())

        try {
            ctx.contentResolver.query(collection, projection, selection, args,
                "${MediaStore.Audio.Media.DATE_MODIFIED} ASC")?.use { c ->
                val idI = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
                val nameI = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
                val sizeI = c.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE)
                val modI = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_MODIFIED)
                val pathI = c.getColumnIndex(pathCol)
                while (c.moveToNext()) {
                    val name = c.getString(nameI) ?: continue
                    val ext = name.substringAfterLast('.', "").lowercase()
                    if (ext !in AUDIO_EXT) continue
                    val relPath = if (pathI >= 0) (c.getString(pathI) ?: "") else ""
                    val size = c.getLong(sizeI)
                    val modMs = c.getLong(modI) * 1000L
                    val id = c.getLong(idI)
                    val itemUri = Uri.withAppendedPath(collection, id.toString())
                    out.add(Rec(name, size, modMs, "$relPath/$name".lowercase(),
                        { try { ctx.contentResolver.openInputStream(itemUri) } catch (_: Exception) { null } },
                        {
                            try {
                                ctx.contentResolver.query(itemUri, arrayOf(MediaStore.Audio.Media.SIZE), null, null, null)
                                    ?.use { if (it.moveToFirst()) it.getLong(0) else null }
                            } catch (_: Exception) { null }
                        }))
                }
            }
        } catch (_: SecurityException) { /* READ_MEDIA_AUDIO not granted yet */ }
        catch (_: Exception) { /* ignore — other channels still run */ }
    }

    // ---- HTTP (no third-party libs; plain HttpURLConnection) ----
    private fun open(cfg: Config, path: String, method: String): HttpURLConnection =
        (URL(cfg.serverUrl + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            setRequestProperty("Authorization", "Bearer ${cfg.token}")
            setRequestProperty("Accept", "application/json")
            connectTimeout = 10000
            readTimeout = 30000
        }

    private fun postJson(cfg: Config, path: String, body: JSONObject): String {
        val conn = open(cfg, path, "POST")
        conn.setRequestProperty("Content-Type", "application/json")
        conn.doOutput = true
        val bytes = body.toString().toByteArray()
        conn.setFixedLengthStreamingMode(bytes.size)
        try {
            conn.outputStream.use { it.write(bytes) }
            val code = conn.responseCode
            val resp = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.readText() ?: ""
            if (code == 401) throw AuthException(resp)
            if (code !in 200..299) throw HttpException(code, errorMessage(resp))
            return resp
        } finally {
            conn.disconnect()
        }
    }

    /** GET /api/sync/status — reachability + token validity check for idle runs. */
    private fun ping(cfg: Config) {
        val conn = open(cfg, "/api/sync/status", "GET")
        try {
            val code = conn.responseCode
            if (code == 401) throw AuthException("")
            if (code !in 200..299) throw HttpException(code, "")
        } finally {
            conn.disconnect()
        }
    }

    /** HEAD /api/sync/recordings/<sha>: 200 = already stored. Anything else → upload. */
    private fun existsOnServer(cfg: Config, sha: String): Boolean {
        val conn = open(cfg, "/api/sync/recordings/$sha", "HEAD")
        try {
            val code = conn.responseCode
            if (code == 401) throw AuthException("")
            return code == 200
        } finally {
            conn.disconnect()
        }
    }

    private fun uploadOne(cfg: Config, rec: Rec, stream: InputStream) {
        val boundary = "----calltrack${System.nanoTime()}"
        val safeName = rec.name.replace("\"", "_").replace("\r", "").replace("\n", "")
        val head = ("--$boundary\r\nContent-Disposition: form-data; name=\"filename\"\r\n\r\n$safeName\r\n" +
            "--$boundary\r\nContent-Disposition: form-data; name=\"last_modified_ms\"\r\n\r\n${rec.lastModified}\r\n" +
            "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"$safeName\"\r\n" +
            "Content-Type: application/octet-stream\r\n\r\n").toByteArray()
        val tail = "\r\n--$boundary--\r\n".toByteArray()
        val conn = open(cfg, "/api/sync/recordings", "POST")
        conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        conn.doOutput = true
        conn.readTimeout = 120000
        // Stream the body (MOB-4): never buffer the whole file in memory.
        conn.setFixedLengthStreamingMode(head.size.toLong() + rec.length + tail.size)
        try {
            conn.outputStream.use { out ->
                out.write(head)
                val copied = stream.use { copyExactly(it, out, rec.length) }
                if (copied != rec.length) throw IOException("file changed during upload")
                out.write(tail)
            }
            val code = conn.responseCode
            val resp = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.readText() ?: ""
            if (code == 401) throw AuthException(resp)
            if (code !in 200..299) throw HttpException(code, errorMessage(resp))
        } finally {
            conn.disconnect()
        }
    }

    private fun copyExactly(src: InputStream, dst: OutputStream, limit: Long): Long {
        val buf = ByteArray(64 * 1024)
        var total = 0L
        while (total < limit) {
            val n = src.read(buf, 0, minOf(buf.size.toLong(), limit - total).toInt())
            if (n < 0) break
            dst.write(buf, 0, n)
            total += n
        }
        return total
    }

    private fun sha256Of(rec: Rec): String {
        val md = MessageDigest.getInstance("SHA-256")
        val stream = rec.open() ?: throw IOException("cannot open ${rec.name}")
        stream.use {
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = it.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private fun errorMessage(body: String): String =
        try { JSONObject(body).optString("error", body) } catch (_: Exception) { body }

    private fun describeHttp(e: HttpException): String {
        val what = when (e.code) {
            413 -> "file too large for the server"
            429 -> "daily upload quota reached — will retry later"
            507 -> "server disk is full — will retry later"
            in 500..599 -> "server error ${e.code} — will retry"
            else -> "HTTP ${e.code}"
        }
        return if (e.body.isBlank() || e.body.length > 120) what else "$what: ${e.body}"
    }

    private fun describe(e: Throwable): String =
        (e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName).take(160)

    private fun isNetworkError(e: Throwable): Boolean =
        e is ConnectException || e is UnknownHostException || e is NoRouteToHostException ||
            e is SocketTimeoutException || e is SocketException ||
            (e is IOException && (e.message ?: "").let { it.contains("Failed to connect") || it.contains("unexpected end of stream") })

    private fun result(calls: Int, recs: Int, errors: List<String>) = JSONObject()
        .put("calls", calls).put("recordings", recs)
        .put("errors", JSONArray(errors))
}
