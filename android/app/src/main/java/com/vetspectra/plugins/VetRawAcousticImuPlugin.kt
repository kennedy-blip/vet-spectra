package com.vetspectra.plugins

import android.Manifest
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.util.Base64
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.content.Context
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean

/**
 * VET-SPECTRA · raw acoustic + IMU capture bridge.
 *
 * Feeds the browser engines with *unprocessed* sensor data so all signal
 * analysis (STFT bands, SMER, gait LAI) happens in the shared ES modules rather
 * than being pre-digested natively:
 *
 *   • 16-bit mono PCM microphone frames  → event `acousticFrame` {pcmBase64, sr, seq}
 *   • accelerometer + gyroscope samples  → event `imu` {t, ax…gz, hz}
 *
 * The 8 s / 48 kHz ceiling keeps a single capture inside a few MB of bridge
 * traffic; long sessions page through `acousticFrame` events instead.
 */
@CapacitorPlugin(
    name = "VetRawAcousticImu",
    permissions = [
        Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])
    ]
)
class VetRawAcousticImuPlugin : Plugin(), SensorEventListener {

    private var audioRecord: AudioRecord? = null
    private var audioThread: Thread? = null
    private val running = AtomicBoolean(false)
    private var sensorManager: SensorManager? = null
    private var accel: Sensor? = null
    private var gyro: Sensor? = null
    private var imuHz = 60
    private var framesEmitted = 0
    private var sampleRate = 24_000
    private var startedAt = 0L

    override fun load() {
        sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        accel = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        gyro = sensorManager?.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    }

    @PluginMethod
    override fun checkPermissions(call: PluginCall) {
        super.checkPermissions(call)
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        if (getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED) {
            call.resolve()
            return
        }
        requestPermissionForAlias("microphone", call, "microphonePermsCallback")
    }

    @PermissionCallback
    private fun microphonePermsCallback(call: PluginCall) {
        if (getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED) {
            call.resolve()
        } else {
            call.reject("RECORD_AUDIO denied — acoustic capture unavailable.")
        }
    }

    /** Start a capture session. `{ sampleRate?: 24000, imuHz?: 60 }` */
    @PluginMethod
    fun startCapture(call: PluginCall) {
        if (running.get()) {
            call.reject("Capture already running.")
            return
        }
        if (getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphonePermsCallback")
            return
        }
        sampleRate = (call.getInt("sampleRate") ?: 24_000).coerceIn(8_000, 48_000)
        imuHz = (call.getInt("imuHz") ?: 60).coerceIn(10, 200)

        val minBuf = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuf <= 0) {
            call.reject("Device cannot record at $sampleRate Hz PCM16 mono.")
            return
        }
        val bufferSize = maxOf(minBuf, sampleRate / 2) // ≥ 0.5 s of headroom
        val record = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                AudioRecord.Builder()
                    .setAudioSource(MediaRecorder.AudioSource.UNPROCESSED)
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(sampleRate)
                            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                            .build()
                    )
                    .setBufferSizeInBytes(bufferSize)
                    .build()
            } else {
                @Suppress("DEPRECATION")
                AudioRecord(
                    MediaRecorder.AudioSource.MIC,
                    sampleRate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufferSize
                )
            }
        } catch (err: Exception) {
            call.reject("AudioRecord init failed: ${err.message}")
            return
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            call.reject("AudioRecord could not be initialised (mic busy?).")
            return
        }

        audioRecord = record
        framesEmitted = 0
        startedAt = System.currentTimeMillis()
        running.set(true)
        record.startRecording()

        // ~85 ms of audio per bridge frame at 24 kHz.
        val frameSamples = (sampleRate * 0.085).toInt()
        audioThread = Thread({
            val pcm = ShortArray(frameSamples)
            while (running.get()) {
                val read = record.read(pcm, 0, frameSamples)
                if (read <= 0) continue
                emitAcousticFrame(pcm, read)
            }
        }, "vet-spectra-audio").apply { isDaemon = true; start() }

        sensorManager?.let { mgr ->
            accel?.let { mgr.registerListener(this@VetRawAcousticImuPlugin, it, imuHz * 1000) }
            gyro?.let { mgr.registerListener(this@VetRawAcousticImuPlugin, it, imuHz * 1000) }
        }

        val payload = JSObject()
        payload.put("sampleRate", sampleRate)
        payload.put("imuHz", imuHz)
        payload.put("sensors", JSObject().apply {
            put("accelerometer", accel != null)
            put("gyroscope", gyro != null)
            put("microphone", true)
        })
        call.resolve(payload)
    }

    /** Stop the session and report what was captured. */
    @PluginMethod
    fun stopCapture(call: PluginCall) {
        val seconds = if (startedAt > 0) (System.currentTimeMillis() - startedAt) / 1000.0 else 0.0
        stopEverything()
        val payload = JSObject()
        payload.put("frames", framesEmitted)
        payload.put("seconds", seconds)
        payload.put("sampleRate", sampleRate)
        call.resolve(payload)
    }

    /** One-shot permission probe for the hardware gatekeeper modal. */
    @PluginMethod
    fun getHardwareProfile(call: PluginCall) {
        val payload = JSObject()
        payload.put("microphone", getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED)
        payload.put("accelerometer", accel != null)
        payload.put("gyroscope", gyro != null)
        payload.put("sampleRate", sampleRate)
        payload.put("sdk", Build.VERSION.SDK_INT)
        payload.put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
        call.resolve(payload)
    }

    @PluginMethod
    fun isCapturing(call: PluginCall) {
        call.resolve(JSObject().put("capturing", running.get()))
    }

    private fun emitAcousticFrame(pcm: ShortArray, read: Int) {
        val bytes = ByteBuffer.allocate(read * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until read) bytes.putShort(pcm[i])
        val payload = JSObject()
        payload.put("pcmBase64", Base64.encodeToString(bytes.array(), Base64.NO_WRAP))
        payload.put("samples", read)
        payload.put("sampleRate", sampleRate)
        payload.put("seq", framesEmitted)
        payload.put("t", System.currentTimeMillis())
        framesEmitted += 1
        notifyListeners("acousticFrame", payload)
    }

    override fun onSensorChanged(event: SensorEvent) {
        val payload = JSObject()
        payload.put("t", System.currentTimeMillis())
        when (event.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> {
                payload.put("kind", "accel")
                payload.put("ax", event.values[0].toDouble())
                payload.put("ay", event.values[1].toDouble())
                payload.put("az", event.values[2].toDouble())
            }
            Sensor.TYPE_GYROSCOPE -> {
                payload.put("kind", "gyro")
                payload.put("gx", event.values[0].toDouble())
                payload.put("gy", event.values[1].toDouble())
                payload.put("gz", event.values[2].toDouble())
            }
            else -> return
        }
        payload.put("hz", imuHz)
        notifyListeners("imu", payload)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private fun stopEverything() {
        running.set(false)
        sensorManager?.unregisterListener(this)
        audioThread?.join(400)
        audioThread = null
        audioRecord?.let { rec ->
            try {
                if (rec.recordingState == AudioRecord.RECORDSTATE_RECORDING) rec.stop()
            } catch (_: IllegalStateException) {
                // already stopped
            }
            rec.release()
        }
        audioRecord = null
    }

    override fun handleOnDestroy() {
        stopEverything()
    }
}
