package com.calltrack.mobile

import android.content.Context
import androidx.work.Worker
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
}
