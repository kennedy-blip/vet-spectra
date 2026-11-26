package com.vetspectra.plugins

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * VET-SPECTRA · macro lens + torch bridge.
 *
 * The tick derma auditor renders its own WebGL magnification, so the device only
 * has to supply (a) a steady, controllable light source for the macro capture and
 * (b) the optical facts the UI needs to report — focal length, minimum focus
 * distance and whether a dedicated macro/tele camera exists.
 *
 * No image data is piped through the bridge: `<input type="file" capture>` and
 * getUserMedia already hand frames to the canvas, and keeping pixels out of the
 * JSON bridge keeps the audit path at 60 fps.
 */
@CapacitorPlugin(name = "VetMacroCameraTorch")
class VetMacroCameraTorchPlugin : Plugin() {

    private var cameraManager: CameraManager? = null
    private var cameraId: String? = null
    private var torchOn = false
    private var torchLevel = 1.0
    private var torchCallback: CameraManager.TorchCallback? = null

    override fun load() {
        cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
        cameraId = pickBackCamera()
        registerTorchCallback()
    }

    /** Hardware facts for the gatekeeper modal + macro HUD. */
    @PluginMethod
    fun getProfile(call: PluginCall) {
        val mgr = cameraManager
        if (mgr == null) {
            call.reject("Camera service unavailable on this device.")
            return
        }
        val payload = JSObject()
        val backId = cameraId
        payload.put("cameraId", backId)
        payload.put("flashAvailable", backId != null && mgr.getCameraCharacteristics(backId)
            .get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true)
        payload.put("torchOn", torchOn)
        payload.put("torchLevel", torchLevel)

        val lenses = JSObject()
        try {
            for (id in mgr.cameraIdList) {
                val ch = mgr.getCameraCharacteristics(id)
                val facing = ch.get(CameraCharacteristics.LENS_FACING)
                val focal = ch.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                val sensor = ch.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
                val focus = ch.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE)
                val zoom = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    ch.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)
                } else null

                val entry = JSObject()
                entry.put("facing", if (facing == CameraCharacteristics.LENS_FACING_FRONT) "front" else "back")
                entry.put("focalMm", focal?.firstOrNull()?.toDouble() ?: 0.0)
                entry.put("minFocusDioptres", focus ?: 0.0)
                // 1 / dioptres = closest focus distance in metres.
                entry.put(
                    "minFocusMm",
                    if ((focus ?: 0f) > 0f) (1000.0 / focus!!.toDouble()) else 0.0
                )
                entry.put("sensorWidthMm", sensor?.width?.toDouble() ?: 0.0)
                entry.put("maxZoom", (zoom?.upper ?: 1f).toDouble())
                entry.put("macroCapable", (focus ?: 0f) >= 8f || (zoom?.upper ?: 1f) >= 3f)
                lenses.put(id, entry)
            }
        } catch (err: Exception) {
            payload.put("lensError", err.message)
        }
        payload.put("lenses", lenses)
        call.resolve(payload)
    }

    /** `{ on: boolean, level?: 0…1 }` — level maps to the torch LED brightness where supported. */
    @PluginMethod
    fun setTorch(call: PluginCall) {
        val mgr = cameraManager ?: run {
            call.reject("Camera service unavailable on this device.")
            return
        }
        val id = cameraId ?: run {
            call.reject("No back camera found.")
            return
        }
        val on = call.getBoolean("on") ?: true
        val level = (call.getDouble("level") ?: 1.0).coerceIn(0.05, 1.0)
        try {
            if (on && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                mgr.turnOnTorchWithStrengthLevel(id, (level * (mgr.getCameraCharacteristics(id)
                    .get(CameraCharacteristics.FLASH_INFO_STRENGTH_MAXIMUM_LEVEL) ?: 1)).toInt().coerceAtLeast(1))
            } else {
                mgr.setTorchMode(id, on)
            }
            torchOn = on
            torchLevel = if (on) level else torchLevel
        } catch (err: Exception) {
            call.reject("Torch control failed: ${err.message}")
            return
        }
        val payload = JSObject()
        payload.put("torchOn", torchOn)
        payload.put("torchLevel", torchLevel)
        call.resolve(payload)
    }

    @PluginMethod
    fun toggleTorch(call: PluginCall) {
        val mgr = cameraManager ?: run {
            call.reject("Camera service unavailable on this device.")
            return
        }
        val id = cameraId ?: run {
            call.reject("No back camera found.")
            return
        }
        val next = !torchOn
        try {
            mgr.setTorchMode(id, next)
            torchOn = next
        } catch (err: Exception) {
            call.reject("Torch toggle failed: ${err.message}")
            return
        }
        call.resolve(JSObject().put("torchOn", torchOn).put("torchLevel", torchLevel))
    }

    /** Called from JS so the macro HUD reflects the true LED state. */
    @PluginMethod
    fun getTorchState(call: PluginCall) {
        val payload = JSObject()
        payload.put("torchOn", torchOn)
        payload.put("torchLevel", torchLevel)
        payload.put("cameraId", cameraId)
        call.resolve(payload)
    }

    private fun pickBackCamera(): String? {
        val mgr = cameraManager ?: return null
        return try {
            mgr.cameraIdList.firstOrNull { id ->
                mgr.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING) ==
                    CameraCharacteristics.LENS_FACING_BACK
            } ?: mgr.cameraIdList.firstOrNull()
        } catch (_: Exception) {
            null
        }
    }

    private fun registerTorchCallback() {
        val mgr = cameraManager ?: return
        torchCallback = object : CameraManager.TorchCallback() {
            override fun onTorchModeChanged(id: String, enabled: Boolean) {
                torchOn = enabled
                notifyListeners("torchChanged", JSObject().put("torchOn", enabled).put("cameraId", id))
            }

            override fun onTorchModeUnavailable(id: String) {
                notifyListeners("torchChanged", JSObject().put("torchOn", false).put("available", false))
            }
        }
        mgr.registerTorchCallback(torchCallback!!, null)
    }

    override fun handleOnDestroy() {
        torchCallback?.let { cameraManager?.unregisterTorchCallback(it) }
        torchCallback = null
        val id = cameraId
        if (torchOn && id != null) {
            try {
                cameraManager?.setTorchMode(id, false)
            } catch (_: Exception) {
                // camera may already be released
            }
        }
    }
}
