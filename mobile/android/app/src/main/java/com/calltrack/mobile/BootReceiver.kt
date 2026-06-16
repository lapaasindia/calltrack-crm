package com.calltrack.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-arms background sync after a reboot. Most OEMs also deliver
 * QUICKBOOT_POWERON / HTC equivalents — we register for the common set in the
 * manifest. Guarded so we never schedule work for an unpaired phone.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_LOCKED_BOOT_COMPLETED ||
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == "com.htc.intent.action.QUICKBOOT_POWERON"
        ) {
            if (SyncEngine.config(context) != null) {
                CallSyncPlugin.schedulePeriodic(context)
                if (CallObserverService.isEnabled(context)) {
                    CallObserverService.start(context)
                }
            }
        }
    }
}
