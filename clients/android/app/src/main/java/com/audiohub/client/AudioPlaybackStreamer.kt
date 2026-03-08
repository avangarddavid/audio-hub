package com.audiohub.client

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.os.Build
import androidx.annotation.RequiresApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit

@RequiresApi(Build.VERSION_CODES.Q)
class AudioPlaybackStreamer(
    private val projection: MediaProjection,
    private val serverUrl: String,
    private val deviceId: String,
    private val name: String,
    private val onStatus: (String) -> Unit
) {
    private val scope = CoroutineScope(Dispatchers.IO)
    private val client = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null
    private var recordJob: Job? = null
    private var audioRecord: AudioRecord? = null
    private var sequence: UInt = 0u

    fun start() {
        val audioUrl = serverUrl
            .trimEnd('/')
            .replace("http://", "ws://")
            .replace("https://", "wss://") + "/audio"

        val request = Request.Builder()
            .url(audioUrl)
            .build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(
                    """
                    {
                      "type":"hello",
                      "deviceId":"$deviceId",
                      "name":"$name",
                      "platform":"android",
                      "codec":"pcm_s16le",
                      "sampleRate":48000,
                      "channels":2,
                      "frameSamples":960
                    }
                    """.trimIndent()
                )
                onStatus("Connected")
                startRecordingLoop(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                onStatus(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                onStatus("Closing: $reason")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onStatus("Closed: $reason")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onStatus("WebSocket error: ${t.message}")
            }
        })
    }

    fun stop() {
        recordJob?.cancel()
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        webSocket?.close(1000, "stopped")
        scope.cancel()
    }

    private fun startRecordingLoop(webSocket: WebSocket) {
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(48_000)
            .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
            .build()

        val captureConfig = AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .build()

        val frameBytes = 960 * 2 * 2
        val minBuffer = AudioRecord.getMinBufferSize(
            48_000,
            AudioFormat.CHANNEL_IN_STEREO,
            AudioFormat.ENCODING_PCM_16BIT
        )

        audioRecord = AudioRecord.Builder()
            .setAudioFormat(format)
            .setBufferSizeInBytes(maxOf(minBuffer * 4, frameBytes * 4))
            .setAudioPlaybackCaptureConfig(captureConfig)
            .build()

        val localRecord = audioRecord ?: return
        localRecord.startRecording()

        recordJob = scope.launch {
            val payload = ByteArray(frameBytes)
            while (isActive) {
                val bytesRead = localRecord.read(payload, 0, payload.size, AudioRecord.READ_BLOCKING)
                if (bytesRead != payload.size) {
                    continue
                }

                val packet = ByteBuffer.allocate(12 + payload.size)
                    .order(ByteOrder.LITTLE_ENDIAN)
                    .putLong(System.currentTimeMillis())
                    .putInt(sequence.toInt())
                    .put(payload)
                    .array()

                sequence += 1u
                webSocket.send(ByteString.of(*packet))
            }
        }
    }
}
