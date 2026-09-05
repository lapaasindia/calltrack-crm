package com.calltrack.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-arms background sync after a reboot. Most OEMs also deliver
 * QUICKBOOT_POWERON / HTC equivalents — we register for the common set in the
 * manifest. Guarded so we never schedule work for an unpaired phone, and the
 * foreground service is only started when the battery exemption makes a
 * background start legal (MOB-7); the periodic job covers the rest.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_LOCKED_BOOT_COMPLETED ||
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == "com.htc.intent.action.QUICKBOOT_POWERON"
        ) {
            if (SyncEngine.config(context) == null) return
            try { CallSyncPlugin.schedulePeriodic(context) } catch (_: Throwable) {}
            try { CallObserverService.startIfAllowedInBackground(context) } catch (_: Throwable) {}
        }
    }
}
