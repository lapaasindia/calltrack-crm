package com.calltrack.mobile

import android.app.Application

/**
 * Process-start entry point. Re-arms the periodic WorkManager schedule every
 * time the OS spins up our process (app open, boot broadcast, JobScheduler
 * wake) so background sync survives reboots and app-swipe-kills even when the
 * WebView never loads. Only re-arms when already paired — never schedules work
 * for an unpaired install.
 *
 * NOTE: We deliberately do NOT implement Configuration.Provider here. Capacitor
 * pulls in androidx.startup, which merges WorkManagerInitializer to initialize
 * WorkManager on-demand. Adding a custom Configuration.Provider here would
 * double-initialize and crash. WorkManager.getInstance(this) is safe.
 */
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        // Re-arm only if the phone is already paired (config present).
        if (SyncEngine.config(this) != null) {
            CallSyncPlugin.schedulePeriodic(this)
            // If the user already opted into the always-on service, restart it.
            if (CallObserverService.isEnabled(this)) {
                CallObserverService.start(this)
            }
        }
    }
}
