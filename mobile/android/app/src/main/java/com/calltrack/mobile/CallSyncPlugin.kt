package com.calltrack.mobile

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.Settings
import android.telecom.TelecomManager
import androidx.activity.result.ActivityResult
import androidx.work.*
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

@CapacitorPlugin(
    name = "CallSync",
    permissions = [
        Permission(alias = "calllog", strings = [Manifest.permission.READ_CALL_LOG]),
        Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS]),
        Permission(alias = "mediaaudio", strings = [Manifest.permission.READ_MEDIA_AUDIO])
    ]
)
class CallSyncPlugin : Plugin() {

    /**
     * Everything the WebView needs in one call. The device token is handed to
     * JS here (memory only) and never persisted on the JS side (MOB-13).
     * Every plugin method resolves with an object: Capacitor's debug bridge
     * logs `undefined` for empty results, which read as noise in logcat.
     */
    @PluginMethod
    fun getState(call: PluginCall) {
        val ctx = context
        val p = SyncEngine.prefs(ctx)
        val perms = JSObject()
            .put("callLog", hasPerm(Manifest.permission.READ_CALL_LOG))
            .put("mediaAudio", if (Build.VERSION.SDK_INT >= 33) hasPerm(Manifest.permission.READ_MEDIA_AUDIO)
                               else hasPerm(Manifest.permission.READ_EXTERNAL_STORAGE))
            .put("notifications", if (Build.VERSION.SDK_INT >= 33) hasPerm(Manifest.permission.POST_NOTIFICATIONS) else true)
        val cfg = SyncEngine.config(ctx)
        val pkg = try { ctx.packageManager.getPackageInfo(ctx.packageName, 0) } catch (_: Exception) { null }
        val versionCode = pkg?.let {
            if (Build.VERSION.SDK_INT >= 28) it.longVersionCode.toInt() else @Suppress("DEPRECATION") it.versionCode
        } ?: 0
        val manufacturer = Build.MANUFACTURER ?: ""
        call.resolve(JSObject()
            .put("permissions", perms)
            .put("paired", cfg != null)
            .put("serverUrl", cfg?.serverUrl)
            .put("token", cfg?.token)
            .put("pairedAt", p.getLong("pairedAt", 0L))
            .put("lastSyncMs", SyncEngine.lastSync(ctx))
            .put("lastSuccessMs", SyncEngine.lastSuccess(ctx))
            .put("lastError", SyncEngine.lastError(ctx))
            .put("pendingUploads", SyncEngine.pendingUploads(ctx))
            .put("safFolderPicked", p.getString("safFolder", null) != null)
            .put("recordingsFolder", p.getString("safFolderName", null))
            .put("batteryOptimized", isBatteryOptimized())
            .put("serviceEnabled", CallObserverService.isEnabled(ctx))
            .put("androidId", androidId())
            .put("deviceModel", deviceModel())
            .put("manufacturer", manufacturer)
            .put("defaultDialer", defaultDialer())
            .put("oemDialer", isOemDialer(manufacturer))
            .put("hasAutostartScreen", autostartIntent() != null)
            .put("appVersion", pkg?.versionName ?: "")
            .put("versionCode", versionCode)
            .put("tokenStorage", SyncEngine.tokenStorage(ctx))
            .put("disconnectedReason", p.getString("disconnectedReason", null)))
    }

    @PluginMethod
    fun requestAppPermissions(call: PluginCall) {
        if (hasPerm(Manifest.permission.READ_CALL_LOG)) { call.resolve(JSObject().put("granted", true)); return }
        requestPermissionForAliases(arrayOf("calllog", "notifications"), call, "permsCallback")
    }

    @PermissionCallback
    fun permsCallback(call: PluginCall) {
        call.resolve(JSObject().put("granted", hasPerm(Manifest.permission.READ_CALL_LOG)))
    }

    @PluginMethod
    fun openBatterySettings(call: PluginCall) {
        val ok = try {
            context.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (_: Exception) { false }
        call.resolve(JSObject().put("opened", ok))
    }

    // Best-effort deep links into the OEM autostart screens (no public API).
    // {oem:false} means only the generic App-info page could be opened — the
    // setup checklist then marks the step "Not needed on this phone" (EMU-15).
    @PluginMethod
    fun openAutostartSettings(call: PluginCall) {
        autostartIntent()?.let { i ->
            try {
                context.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                call.resolve(JSObject().put("opened", true).put("oem", true)); return
            } catch (_: Exception) {}
        }
        val ok = try {
            context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (_: Exception) { false }
        call.resolve(JSObject().put("opened", ok).put("oem", false))
    }

    // OEM dialers keep their "call recording" toggle inside the Phone app. The
    // closest public entry points: the system call-settings screen, then the
    // dialer app itself, then the dial pad.
    @PluginMethod
    fun openDialerSettings(call: PluginCall) {
        val candidates = mutableListOf(Intent(TelecomManager.ACTION_SHOW_CALL_SETTINGS))
        defaultDialer()?.let { pkg ->
            context.packageManager.getLaunchIntentForPackage(pkg)?.let { candidates.add(it) }
        }
        candidates.add(Intent(Intent.ACTION_DIAL))
        for (i in candidates) {
            try {
                context.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                call.resolve(JSObject().put("opened", true)); return
            } catch (_: Exception) {}
        }
        call.resolve(JSObject().put("opened", false))
    }

    // ---- SAF: let the user point us at their dialer's recordings folder ----
    @PluginMethod
    fun pickRecordingsFolder(call: PluginCall) {
        val i = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            try {
                putExtra(DocumentsContract.EXTRA_INITIAL_URI,
                    Uri.parse("content://com.android.externalstorage.documents/document/primary%3ARecordings"))
            } catch (_: Exception) {}
        }
        startActivityForResult(call, i, "folderPickedResult")
    }

    @ActivityCallback
    fun folderPickedResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val treeUri: Uri? = if (result.resultCode == Activity.RESULT_OK) result.data?.data else null
        if (treeUri == null) { call.resolve(JSObject().put("picked", false)); return }
        val docId = try { DocumentsContract.getTreeDocumentId(treeUri) } catch (_: Exception) { "" }
        // "primary:" with nothing after the colon is the WHOLE volume (MOB-10):
        // refuse it — every song and voice note would become a "call recording".
        val rel = docId.substringAfter(':', "").trim('/')
        if (rel.isBlank()) {
            call.resolve(JSObject().put("picked", false)
                .put("error", "That is the whole phone storage — choose the folder your Phone app saves call recordings in (for example Recordings/Call)"))
            return
        }
        try {
            context.contentResolver.takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (e: Exception) {
            call.resolve(JSObject().put("picked", false).put("error", e.message)); return
        }
        SyncEngine.prefs(context).edit()
            .putString("safFolder", treeUri.toString())
            .putString("safFolderName", rel)
            .apply()
        call.resolve(JSObject().put("picked", true).put("name", rel).put("uri", treeUri.toString()))
    }

    @PluginMethod
    fun requestMediaAudio(call: PluginCall) {
        if (Build.VERSION.SDK_INT < 33 || hasPerm(Manifest.permission.READ_MEDIA_AUDIO)) {
            call.resolve(JSObject().put("granted", true)); return
        }
        requestPermissionForAliases(arrayOf("mediaaudio"), call, "mediaAudioCallback")
    }

    @PermissionCallback
    fun mediaAudioCallback(call: PluginCall) {
        call.resolve(JSObject().put("granted", Build.VERSION.SDK_INT < 33 || hasPerm(Manifest.permission.READ_MEDIA_AUDIO)))
    }

    @PluginMethod
    fun startBackgroundService(call: PluginCall) {
        val ok = CallObserverService.start(context)
        call.resolve(JSObject().put("started", ok))
    }

    @PluginMethod
    fun stopBackgroundService(call: PluginCall) {
        CallObserverService.stop(context)
        call.resolve(JSObject().put("started", false))
    }

    /** Pairing (and a harmless re-arm from boot). Never moves pairedAt — see SyncEngine.saveConfig. */
    @PluginMethod
    fun configure(call: PluginCall) {
        val url = call.getString("serverUrl") ?: return call.reject("serverUrl required")
        val token = call.getString("token") ?: return call.reject("token required")
        SyncEngine.saveConfig(context, url, token)
        schedulePeriodic(context)
        call.resolve(JSObject().put("ok", true))
    }

    /** Disconnect: wipes config + ledgers, cancels all work, stops the FGS and its notification. */
    @PluginMethod
    fun clearConfig(call: PluginCall) {
        SyncEngine.clearConfig(context)
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun syncNow(call: PluginCall) {
        val ctx = context
        Thread {
            val res: JSONObject = try {
                SyncEngine.sync(ctx)
            } catch (t: Throwable) { // incl. OutOfMemoryError — never let it kill the process
                JSONObject().put("calls", 0).put("recordings", 0)
                    .put("errors", JSONArray(listOf(t.message ?: t.javaClass.simpleName)))
            }
            try { call.resolve(JSObject.fromJSONObject(res)) }
            catch (t: Throwable) { call.reject(t.message ?: "sync failed") }
        }.start()
    }

    @PluginMethod
    fun checkForUpdate(call: PluginCall) {
        val cfg = SyncEngine.config(context)
            ?: return call.resolve(JSObject().put("updateAvailable", false).put("error", "Not paired"))
        val ctx = context
        Thread {
            try {
                val conn = (URL("${cfg.serverUrl}/api/app-version").openConnection() as HttpURLConnection)
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                val code = conn.responseCode
                val txt = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.readText() ?: ""
                conn.disconnect()
                if (code !in 200..299) throw RuntimeException("HTTP $code")
                val meta = JSONObject(txt)
                val current = ctx.packageManager.getPackageInfo(ctx.packageName, 0).let {
                    if (Build.VERSION.SDK_INT >= 28) it.longVersionCode.toInt() else @Suppress("DEPRECATION") it.versionCode
                }
                val latest = meta.optInt("versionCode", 0)
                call.resolve(JSObject()
                    .put("updateAvailable", latest > current)
                    .put("versionName", meta.optString("versionName"))
                    .put("latestVersionCode", latest)
                    .put("currentVersionCode", current)
                    .put("apkUrl", "${cfg.serverUrl}/download/calltrack.apk"))
            } catch (t: Throwable) {
                call.resolve(JSObject().put("updateAvailable", false).put("error", t.message ?: t.javaClass.simpleName))
            }
        }.start()
    }

    // Hands the APK URL to the browser (download + tap to install). No
    // REQUEST_INSTALL_PACKAGES needed for that path (MOB-14/MOB-19).
    @PluginMethod
    fun installUpdate(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url required")
        val ok = try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true
        } catch (_: Exception) { false }
        call.resolve(JSObject().put("opened", ok))
    }

    /**
     * Activity resumed — e.g. back from the battery-exemption dialog, the SAF
     * picker or an OEM settings screen. Those are translucent/overlay
     * activities on many phones, so the WebView never sees a visibilitychange;
     * this event lets the setup checklist refresh itself (EMU-8).
     */
    override fun handleOnResume() {
        super.handleOnResume()
        try { notifyListeners("appResumed", JSObject().put("at", System.currentTimeMillis())) } catch (_: Throwable) {}
    }

    // ---- helpers ----
    private fun hasPerm(p: String) =
        context.checkSelfPermission(p) == android.content.pm.PackageManager.PERMISSION_GRANTED

    private fun isBatteryOptimized(): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
        return !pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    @Suppress("HardwareIds")
    private fun androidId() =
        Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown"

    private fun deviceModel(): String {
        val m = Build.MANUFACTURER ?: ""
        val model = Build.MODEL ?: ""
        val s = if (model.startsWith(m, ignoreCase = true)) model else "$m $model"
        return s.trim().replaceFirstChar { it.uppercase() }.take(80)
    }

    private fun defaultDialer(): String? = try {
        (context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager)?.defaultDialerPackage
    } catch (_: Exception) { null }

    // Whether this phone's own dialer can record calls (the setup step is
    // pointless on Google/AOSP dialers, which cannot).
    private fun isOemDialer(manufacturer: String): Boolean {
        if (OEM_RECORDING_BRANDS.contains(manufacturer.lowercase())) return true
        val d = defaultDialer() ?: return false
        return d != "com.google.android.dialer" && d != "com.android.dialer"
    }

    @Suppress("DEPRECATION")
    private fun autostartIntent(): Intent? {
        val pm = context.packageManager
        for ((pkg, cls) in AUTOSTART_SCREENS) {
            val i = Intent().setClassName(pkg, cls)
            if (pm.resolveActivity(i, 0) != null) return i
        }
        return null
    }

    companion object {
        const val PERIODIC_WORK = "calltrack_periodic_sync"

        private val OEM_RECORDING_BRANDS = setOf(
            "xiaomi", "redmi", "poco", "samsung", "realme", "oppo", "oneplus", "vivo", "iqoo",
            "huawei", "honor", "tecno", "infinix", "itel"
        )
        // Also declared under <queries> in the manifest so resolveActivity can see them on API 30+.
        private val AUTOSTART_SCREENS = listOf(
            "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
            "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
            "com.samsung.android.lool" to "com.samsung.android.sm.battery.ui.BatteryActivity",
            "com.oneplus.security" to "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity",
            "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"
        )

        fun schedulePeriodic(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(ctx.applicationContext).enqueueUniquePeriodicWork(
                PERIODIC_WORK, ExistingPeriodicWorkPolicy.UPDATE, req)
        }
    }
}
