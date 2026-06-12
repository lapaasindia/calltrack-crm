package com.calltrack.mobile

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.work.*
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

@CapacitorPlugin(
    name = "CallSync",
    permissions = [
        Permission(alias = "calllog", strings = [Manifest.permission.READ_CALL_LOG, Manifest.permission.READ_PHONE_STATE]),
        Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])
    ]
)
class CallSyncPlugin : Plugin() {

    @PluginMethod
    fun getState(call: PluginCall) {
        val ctx = context
        val perms = JSObject()
            .put("callLog", hasPerm(Manifest.permission.READ_CALL_LOG))
            .put("storage", hasAllFilesAccess())
            .put("notifications", if (Build.VERSION.SDK_INT >= 33) hasPerm(Manifest.permission.POST_NOTIFICATIONS) else true)
        val ledger = SyncEngine.prefs(ctx).getStringSet("uploaded", emptySet())!!.size
        call.resolve(JSObject()
            .put("permissions", perms)
            .put("lastSyncMs", SyncEngine.lastSync(ctx))
            .put("pendingUploads", 0)
            .put("uploadedCount", ledger)
            .put("batteryOptimized", isBatteryOptimized())
            .put("androidId", androidId()))
    }

    @PluginMethod
    fun requestAppPermissions(call: PluginCall) {
        if (hasPerm(Manifest.permission.READ_CALL_LOG)) { call.resolve(JSObject().put("granted", true)); return }
        requestPermissionForAliases(arrayOf("calllog", "notifications"), call, "permsCallback")
    }

    @com.getcapacitor.annotation.PermissionCallback
    fun permsCallback(call: PluginCall) {
        call.resolve(JSObject().put("granted", hasPerm(Manifest.permission.READ_CALL_LOG)))
    }

    @PluginMethod
    fun openAllFilesAccess(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= 30) {
            val i = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                Uri.parse("package:${context.packageName}"))
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try { context.startActivity(i) } catch (_: Exception) {
                context.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
        call.resolve()
    }

    @PluginMethod
    fun openBatterySettings(call: PluginCall) {
        try {
            context.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {}
        call.resolve()
    }

    // Best-effort deep links into the OEM autostart screens (no public API).
    @PluginMethod
    fun openAutostartSettings(call: PluginCall) {
        val intents = listOf(
            "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
            "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
            "com.samsung.android.lool" to "com.samsung.android.sm.battery.ui.BatteryActivity",
            "com.oneplus.security" to "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"
        )
        for ((pkg, cls) in intents) {
            try {
                context.startActivity(Intent().setClassName(pkg, cls).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                call.resolve(); return
            } catch (_: Exception) {}
        }
        // Fallback: this app's settings page.
        try {
            context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {}
        call.resolve()
    }

    @PluginMethod
    fun configure(call: PluginCall) {
        val url = call.getString("serverUrl") ?: return call.reject("serverUrl required")
        val token = call.getString("token") ?: return call.reject("token required")
        SyncEngine.saveConfig(context, url, token)
        schedulePeriodic(context)
        call.resolve()
    }

    @PluginMethod
    fun clearConfig(call: PluginCall) {
        SyncEngine.clearConfig(context)
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC_WORK)
        call.resolve()
    }

    @PluginMethod
    fun syncNow(call: PluginCall) {
        Thread {
            val res: JSONObject = try { SyncEngine.sync(context) }
            catch (e: Exception) { JSObject().put("calls", 0).put("recordings", 0)
                .put("errors", org.json.JSONArray(listOf(e.message ?: "sync failed"))) }
            call.resolve(JSObject.fromJSONObject(res))
        }.start()
    }

    @PluginMethod
    fun checkForUpdate(call: PluginCall) {
        val cfg = SyncEngine.config(context) ?: return call.resolve(JSObject().put("updateAvailable", false))
        Thread {
            try {
                val conn = (URL("${cfg.serverUrl}/api/app-version").openConnection() as HttpURLConnection)
                conn.connectTimeout = 8000
                val txt = conn.inputStream.bufferedReader().readText()
                conn.disconnect()
                val meta = JSONObject(txt)
                val current = context.packageManager.getPackageInfo(context.packageName, 0).let {
                    if (Build.VERSION.SDK_INT >= 28) it.longVersionCode.toInt() else @Suppress("DEPRECATION") it.versionCode
                }
                val latest = meta.optInt("versionCode", 0)
                call.resolve(JSObject()
                    .put("updateAvailable", latest > current)
                    .put("versionName", meta.optString("versionName"))
                    .put("apkUrl", "${cfg.serverUrl}/download/calltrack.apk"))
            } catch (e: Exception) {
                call.resolve(JSObject().put("updateAvailable", false).put("error", e.message))
            }
        }.start()
    }

    @PluginMethod
    fun installUpdate(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url required")
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {}
        call.resolve()
    }

    // ---- helpers ----
    private fun hasPerm(p: String) =
        context.checkSelfPermission(p) == android.content.pm.PackageManager.PERMISSION_GRANTED

    private fun hasAllFilesAccess() =
        if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager()
        else hasPerm(Manifest.permission.READ_EXTERNAL_STORAGE)

    private fun isBatteryOptimized(): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
        return !pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    @Suppress("HardwareIds")
    private fun androidId() =
        Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown"

    companion object {
        const val PERIODIC_WORK = "calltrack_periodic_sync"
        fun schedulePeriodic(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<SyncWorker>(45, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                PERIODIC_WORK, ExistingPeriodicWorkPolicy.UPDATE, req)
        }
    }
}
