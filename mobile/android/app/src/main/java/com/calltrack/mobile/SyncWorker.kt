package com.calltrack.mobile

import android.content.Context
import android.app.Notification
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.Worker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters

/** Background sync. Best-effort on Indian OEMs — sync-on-app-open is primary. */
class SyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val cfg = SyncEngine.config(applicationContext) ?: return Result.success()
        return try {
            val res = SyncEngine.sync(applicationContext)
            val errors = res.getJSONArray("errors")
            if (errors.length() > 0) Result.retry() else Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }

    // Required when an expedited request is promoted to a foreground job on
    // API 31+. Reuses the persistent FGS channel so no extra notification noise.
    override fun getForegroundInfo(): ForegroundInfo {
        val notif: Notification = NotificationCompat.Builder(
            applicationContext, CallObserverService.CHANNEL_ID
        )
            .setContentTitle("CallTrack")
            .setContentText("Syncing a call…")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
        return if (Build.VERSION.SDK_INT >= 29) {
            ForegroundInfo(
                CallObserverService.NOTIF_ID + 1, notif,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            ForegroundInfo(CallObserverService.NOTIF_ID + 1, notif)
        }
    }
}
