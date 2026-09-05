package com.calltrack.mobile

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.getcapacitor.Plugin

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(CallSyncPlugin::class.java)
        // DebugSeeder exists only in the debug build — register it if present.
        try {
            @Suppress("UNCHECKED_CAST")
            val cls = Class.forName("com.calltrack.mobile.DebugSeederPlugin") as Class<out Plugin>
            registerPlugin(cls)
        } catch (_: ClassNotFoundException) { /* release build */ }
        super.onCreate(savedInstanceState)
        // The activity is the one place a foreground-service start is always
        // legal: re-arm the observer service here if the user enabled it (MOB-7).
        try {
            if (SyncEngine.config(this) != null && CallObserverService.isEnabled(this)) {
                CallObserverService.start(this)
            }
        } catch (_: Throwable) {}
    }
}
