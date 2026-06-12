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
    }
}
