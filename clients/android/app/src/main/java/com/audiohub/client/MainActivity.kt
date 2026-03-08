package com.audiohub.client

import android.content.Context
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

class MainActivity : ComponentActivity() {
    private var pendingServerUrl: String = "http://192.168.1.10:4010"
    private var pendingName: String = "Android"
    private var pendingDeviceId: String = "android-device"
    private var statusState by mutableStateOf("Idle")
    private var streamer: AudioPlaybackStreamer? = null

    private val projectionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            statusState = "Android 10+ required"
            return@registerForActivityResult
        }

        if (result.resultCode != RESULT_OK || result.data == null) {
            statusState = "Permission denied"
            return@registerForActivityResult
        }

        val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val projection = projectionManager.getMediaProjection(result.resultCode, result.data!!)

        streamer?.stop()
        streamer = AudioPlaybackStreamer(
            projection = projection,
            serverUrl = pendingServerUrl,
            deviceId = pendingDeviceId,
            name = pendingName,
            onStatus = { status -> runOnUiThread { statusState = status } }
        )
        streamer?.start()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            MaterialTheme {
                Surface(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(
                            brush = Brush.verticalGradient(
                                listOf(Color(0xFF0B1320), Color(0xFF162033), Color(0xFF0D1118))
                            )
                        )
                ) {
                    AudioHubScreen(
                        initialServer = pendingServerUrl,
                        initialName = pendingName,
                        initialDeviceId = pendingDeviceId,
                        status = statusState,
                        onStart = { serverUrl, name, deviceId ->
                            pendingServerUrl = serverUrl
                            pendingName = name
                            pendingDeviceId = deviceId
                            requestProjection()
                        },
                        onStop = {
                            streamer?.stop()
                            streamer = null
                            statusState = "Stopped"
                        }
                    )
                }
            }
        }
    }

    override fun onDestroy() {
        streamer?.stop()
        super.onDestroy()
    }

    private fun requestProjection() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            statusState = "Android 10+ required"
            return
        }

        val projectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projectionLauncher.launch(projectionManager.createScreenCaptureIntent())
    }
}

@Composable
private fun AudioHubScreen(
    initialServer: String,
    initialName: String,
    initialDeviceId: String,
    status: String,
    onStart: (String, String, String) -> Unit,
    onStop: () -> Unit
) {
    var serverUrl by mutableStateOf(initialServer)
    var name by mutableStateOf(initialName)
    var deviceId by mutableStateOf(initialDeviceId)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text(
            text = "Audio Hub Android Client",
            style = MaterialTheme.typography.headlineMedium,
            color = Color.White
        )
        Text(
            text = "Status: $status",
            style = MaterialTheme.typography.bodyLarge,
            color = Color(0xFFC4CFDA)
        )
        OutlinedTextField(
            value = serverUrl,
            onValueChange = { serverUrl = it },
            label = { Text("Server URL") },
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = name,
            onValueChange = { name = it },
            label = { Text("Device name") },
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = deviceId,
            onValueChange = { deviceId = it },
            label = { Text("Device ID") },
            modifier = Modifier.fillMaxWidth()
        )
        Button(
            onClick = { onStart(serverUrl, name, deviceId) },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Start capture")
        }
        Button(
            onClick = onStop,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Stop")
        }
        Text(
            text = "Android limitation: playback capture works only for apps that allow capture on Android 10+.",
            style = MaterialTheme.typography.bodyMedium,
            color = Color(0xFF8DD2C7)
        )
    }
}
