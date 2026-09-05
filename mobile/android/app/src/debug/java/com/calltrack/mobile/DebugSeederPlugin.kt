package com.calltrack.mobile

import android.content.ContentValues
import android.os.Environment
import android.provider.CallLog
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * DEBUG-ONLY. Injects fake call-log rows and fake recording files so the
 * sync pipeline can be exercised on an emulator without placing real calls.
 * Compiled only into the debug build — never shipped. Every method catches
 * its own failures and rejects the call (an uncaught exception on the plugin
 * thread would take the whole app down — EMU-13).
 */
@CapacitorPlugin(name = "DebugSeeder")
class DebugSeederPlugin : Plugin() {

    @PluginMethod
    fun seedCall(call: PluginCall) {
        try {
            val number = call.getString("phone") ?: return call.reject("phone required")
            val durationSec = call.getInt("duration", 0)!!
            val ts = call.getString("ts")?.toLongOrNull() ?: System.currentTimeMillis()
            val type = when (call.getString("direction", "outgoing")) {
                "incoming" -> CallLog.Calls.INCOMING_TYPE
                "missed" -> CallLog.Calls.MISSED_TYPE
                else -> CallLog.Calls.OUTGOING_TYPE
            }
            val values = ContentValues().apply {
                put(CallLog.Calls.NUMBER, number)
                put(CallLog.Calls.TYPE, type)
                put(CallLog.Calls.DURATION, durationSec)
                put(CallLog.Calls.DATE, ts)
                put(CallLog.Calls.NEW, 1)
            }
            context.contentResolver.insert(CallLog.Calls.CONTENT_URI, values)
            call.resolve(JSObject().put("ok", true))
        } catch (t: Throwable) {
            call.reject("seedCall failed: ${t.message ?: t.javaClass.simpleName}")
        }
    }

    // Writes under a MEDIA directory (default Recordings/Call) — under scoped
    // storage an app may create its own files there without All-Files-Access,
    // whereas OEM paths like MIUI/sound_recorder are not writable (EMU-7).
    @PluginMethod
    fun seedRecording(call: PluginCall) {
        try {
            val filename = call.getString("filename") ?: return call.reject("filename required")
            val folder = call.getString("folder", "Recordings/Call")!!
            val sizeKb = call.getInt("sizeKb", 8)!!
            val dir = File(Environment.getExternalStorageDirectory(), folder)
            if (!dir.isDirectory && !dir.mkdirs()) return call.reject("cannot create $dir (scoped storage?)")
            val f = File(dir, filename)
            // Fake audio bytes, made DISTINCT per filename so each gets a unique
            // sha256 (the server dedupes identical uploads — correct in production,
            // but we want separate rows here). Matching is by filename/timestamp.
            val seed = filename.hashCode()
            f.writeBytes(ByteArray(sizeKb * 1024) { ((it + seed) % 256).toByte() })
            call.getString("ts")?.toLongOrNull()?.let { f.setLastModified(it) }
            call.resolve(JSObject().put("ok", true).put("path", f.absolutePath))
        } catch (t: Throwable) {
            call.reject("seedRecording failed: ${t.message ?: t.javaClass.simpleName}")
        }
    }

    @PluginMethod
    fun clearAll(call: PluginCall) {
        try {
            context.contentResolver.delete(CallLog.Calls.CONTENT_URI, null, null)
            call.resolve(JSObject().put("ok", true))
        } catch (t: Throwable) {
            call.reject("clearAll failed: ${t.message ?: t.javaClass.simpleName}")
        }
    }
}
