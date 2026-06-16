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
 */
class CallObserverService : Service() {

    private lateinit var observer: CallLogObserver
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate() {
        super.onCreate()
        startInForeground()
        observer = CallLogObserver(handler)
        // notifyForDescendants=true: some OEMs notify on a child uri, not the
        // base CONTENT_URI.
        contentResolver.registerContentObserver(
            CallLog.Calls.CONTENT_URI, true, observer
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Re-assert foreground in case the system restarted us.
        startInForeground()
        return START_STICKY
    }

    override fun onDestroy() {
        try { contentResolver.unregisterContentObserver(observer) } catch (_: Exception) {}
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startInForeground() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel(
                CHANNEL_ID, "Background call sync",
                NotificationManager.IMPORTANCE_MIN
            ).apply {
                description = "Keeps your calls syncing to the office CRM"
                setShowBadge(false)
            }
            nm.createNotificationChannel(ch)
        }
        val tapIntent = packageManager.getLaunchIntentForPackage(packageName)?.let {
            android.app.PendingIntent.getActivity(
                this, 0, it,
                android.app.PendingIntent.FLAG_IMMUTABLE or
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT
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
            startForeground(
                NOTIF_ID, notif,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(NOTIF_ID, notif)
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

        fun start(ctx: Context) {
            setEnabled(ctx, true)
            val i = Intent(ctx, CallObserverService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i)
            else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            setEnabled(ctx, false)
            ctx.stopService(Intent(ctx, CallObserverService::class.java))
        }

        /** Expedited one-time sync — runs within seconds, foreground quota. */
        fun enqueueExpeditedSync(ctx: Context) {
            if (SyncEngine.config(ctx) == null) return
            val req = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setBackoffCriteria(BackoffPolicy.LINEAR, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(ctx).enqueueUniqueWork(
                EXPEDITED_WORK, ExistingWorkPolicy.REPLACE, req
            )
        }
    }
}
