package com.calltrack.mobile

import android.app.Application

/**
 * Process-start entry point. Re-arms the periodic WorkManager schedule every
 * time the OS spins up our process (app open, boot broadcast, JobScheduler
 * wake) so background sync survives reboots and app-swipe-kills even when the
 * WebView never loads. Only re-arms when already paired — never schedules work
 * for an unpaired install.
 *
 * The foreground service is only (re)started from here when the app is exempt
 * from battery optimisation; otherwise a background start would throw on
 * API 31+ and crash-loop every WorkManager wake (MOB-7). MainActivity starts
 * it from the foreground on the next app open.
 *
 * NOTE: We deliberately do NOT implement Configuration.Provider here. Capacitor
 * pulls in androidx.startup, which merges WorkManagerInitializer to initialize
 * WorkManager on-demand. Adding a custom Configuration.Provider here would
 * double-initialize and crash. WorkManager.getInstance(this) is safe.
 */
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        if (SyncEngine.config(this) == null) return
        try { CallSyncPlugin.schedulePeriodic(this) } catch (_: Throwable) {}
        try { CallObserverService.startIfAllowedInBackground(this) } catch (_: Throwable) {}
    }
}
