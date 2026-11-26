package com.vetspectra.clinical

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.vetspectra.plugins.VetMacroCameraTorchPlugin
import com.vetspectra.plugins.VetRawAcousticImuPlugin

/**
 * Single-activity host. The whole clinical workstation is the SvelteKit bundle in
 * `assets/public`; the only native surface is the raw sensor/torch bridge.
 */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(VetRawAcousticImuPlugin::class.java)
        registerPlugin(VetMacroCameraTorchPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
