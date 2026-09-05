package com.calltrack.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.database.ContentObserver
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.provider.CallLog
import androidx.core.app.NotificationCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Always-on foreground dataSync service. Watches the system CallLog via a
 * ContentObserver; when a call row changes (i.e. a call just ended and was
 * written to the log), it enqueues an EXPEDITED one-time SyncWorker so the
 * just-ended call + its recording upload within seconds — without the WebView
 * ever being open. The user accepts a persistent low-priority notification.
 *
 * Debounced: OEM dialers write the call row, then patch duration/recording a
 * beat later, firing onChange 2-4 times per call. We coalesce into one sync.
 *
 * Starting a foreground service from the background throws on API 31+
 * (ForegroundServiceStartNotAllowedException) unless the app is exempt from
 * battery optimisation — every start is therefore guarded (MOB-7).
 */
class CallObserverService : Service() {

    private var observer: CallLogObserver? = null
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate() {
        super.onCreate()
        if (!startInForeground()) { stopSelf(); return }
        observer = CallLogObserver(handler).also {
            // notifyForDescendants=true: some OEMs notify on a child uri, not
            // the base CONTENT_URI.
            try { contentResolver.registerContentObserver(CallLog.Calls.CONTENT_URI, true, it) }
            catch (_: Exception) {}
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Re-assert foreground in case the system restarted us.
        if (!startInForeground()) { stopSelf(); return START_NOT_STICKY }
        return START_STICKY
    }

    override fun onDestroy() {
        observer?.let { try { contentResolver.unregisterContentObserver(it) } catch (_: Exception) {} }
        handler.removeCallbacksAndMessages(null)
        try {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE)
            else @Suppress("DEPRECATION") stopForeground(true)
        } catch (_: Exception) {}
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** False if the OS refused (background start not allowed) — caller stops the service. */
    private fun startInForeground(): Boolean {
        return try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= 26) {
                val ch = NotificationChannel(CHANNEL_ID, "Background call sync", NotificationManager.IMPORTANCE_MIN).apply {
                    description = "Keeps your calls syncing to the office CRM"
                    setShowBadge(false)
                }
                nm.createNotificationChannel(ch)
            }
            val tapIntent = packageManager.getLaunchIntentForPackage(packageName)?.let {
                android.app.PendingIntent.getActivity(
                    this, 0, it,
                    android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT
                )
            }
            val notif: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("CallTrack is active")
                .setContentText("Syncing your calls to the office CRM")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setContentIntent(tapIntent)
                .build()
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIF_ID, notif)
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    /** Debounced observer — coalesces the burst of onChange events per call. */
    private inner class CallLogObserver(h: Handler) : ContentObserver(h) {
        private val debounce = Runnable { enqueueExpeditedSync(this@CallObserverService) }
        override fun onChange(selfChange: Boolean) = onChange(selfChange, null)
        override fun onChange(selfChange: Boolean, uri: android.net.Uri?) {
            handler.removeCallbacks(debounce)
            // 4s lets the OEM dialer finish writing duration + flush the
            // recording file before we read & upload.
            handler.postDelayed(debounce, 4_000L)
        }
    }

    companion object {
        const val CHANNEL_ID = "calltrack_fgs"
        const val NOTIF_ID = 4711
        const val EXPEDITED_WORK = "calltrack_expedited_sync"
        private const val PREF_ENABLED = "fgsEnabled"

        fun isEnabled(ctx: Context): Boolean =
            SyncEngine.prefs(ctx).getBoolean(PREF_ENABLED, false)

        fun setEnabled(ctx: Context, enabled: Boolean) {
            SyncEngine.prefs(ctx).edit().putBoolean(PREF_ENABLED, enabled).apply()
        }

        /** Start (from a foreground context, e.g. the activity). Returns false if the OS refused. */
        fun start(ctx: Context): Boolean {
            setEnabled(ctx, true)
            val i = Intent(ctx, CallObserverService::class.java)
            return try {
                if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
                true
            } catch (_: Exception) { // ForegroundServiceStartNotAllowedException, IllegalStateException, SecurityException
                false
            }
        }

        /**
         * Background entry points (App.onCreate, BootReceiver) may only start the
         * FGS when the app is exempt from battery optimisation; otherwise the
         * periodic WorkManager job is the fallback and the next app open starts
         * the service from the foreground.
         */
        fun startIfAllowedInBackground(ctx: Context): Boolean {
            if (!isEnabled(ctx)) return false
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
            if (!pm.isIgnoringBatteryOptimizations(ctx.packageName)) return false
            return start(ctx)
        }

        fun stop(ctx: Context) {
            setEnabled(ctx, false)
            try { ctx.stopService(Intent(ctx, CallObserverService::class.java)) } catch (_: Exception) {}
            try {
                (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_ID)
            } catch (_: Exception) {}
        }

        /** Expedited one-time sync — runs within seconds, foreground quota. */
        fun enqueueExpeditedSync(ctx: Context) {
            if (SyncEngine.config(ctx) == null) return
            val req = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.LINEAR, 30, TimeUnit.SECONDS)
                .build()
            // KEEP (MOB-12): never cancel an in-flight upload because another
            // call ended; the running sync (or the periodic one) picks it up.
            WorkManager.getInstance(ctx.applicationContext).enqueueUniqueWork(
                EXPEDITED_WORK, ExistingWorkPolicy.KEEP, req
            )
        }
    }
}
