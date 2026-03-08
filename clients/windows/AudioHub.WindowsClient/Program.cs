using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

var options = ClientOptions.Parse(args);
using var streamer = new WindowsAudioStreamer(options);
await streamer.RunAsync();

internal static class AudioConstants
{
    public const int SampleRate = 48000;
    public const int Channels = 2;
    public const int FrameDurationMs = 20;
    public const int FrameSamples = SampleRate * FrameDurationMs / 1000;
    public const int BytesPerFrame = FrameSamples * Channels * 2;
}

internal sealed record ClientOptions(
    Uri AudioUri,
    string DeviceId,
    string Name
)
{
    public static ClientOptions Parse(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        for (var i = 0; i < args.Length; i++)
        {
            if (!args[i].StartsWith("--", StringComparison.Ordinal))
            {
                continue;
            }

            var key = args[i][2..];
            if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
            {
                values[key] = args[i + 1];
                i++;
            }
            else
            {
                values[key] = "true";
            }
        }

        var server = values.TryGetValue("server", out var serverValue)
            ? serverValue
            : Environment.GetEnvironmentVariable("AUDIO_HUB_SERVER") ?? "http://127.0.0.1:4010";

        var hostName = Environment.MachineName;
        var deviceId = values.TryGetValue("device-id", out var deviceIdValue)
            ? deviceIdValue
            : Environment.GetEnvironmentVariable("AUDIO_HUB_DEVICE_ID") ?? $"windows-{hostName}";

        var name = values.TryGetValue("name", out var nameValue)
            ? nameValue
            : Environment.GetEnvironmentVariable("AUDIO_HUB_NAME") ?? hostName;

        var audioUri = new Uri(server.Replace("http://", "ws://", StringComparison.OrdinalIgnoreCase)
                                     .Replace("https://", "wss://", StringComparison.OrdinalIgnoreCase)
                                     .TrimEnd('/') + "/audio");

        return new ClientOptions(audioUri, deviceId, name);
    }
}

internal sealed class WindowsAudioStreamer : IDisposable
{
    private readonly ClientOptions _options;
    private readonly CancellationTokenSource _cts = new();
    private readonly SemaphoreSlim _connectLock = new(1, 1);
    private readonly byte[] _sendFrameBuffer = new byte[AudioConstants.BytesPerFrame];

    private ClientWebSocket? _socket;
    private WasapiLoopbackCapture? _capture;
    private BufferedWaveProvider? _bufferedProvider;
    private IWaveProvider? _pcm16Provider;
    private Task? _sendLoop;
    private Task? _receiveLoop;
    private uint _sequence;

    public WindowsAudioStreamer(ClientOptions options)
    {
        _options = options;
    }

    public async Task RunAsync()
    {
        StartCapture();
        _sendLoop = Task.Run(() => SendLoopAsync(_cts.Token));

        Console.WriteLine($"[windows-client] streaming {_options.Name} to {_options.AudioUri}");

        await _sendLoop;
    }

    public void Dispose()
    {
        _cts.Cancel();
        _capture?.StopRecording();
        _capture?.Dispose();
        _socket?.Dispose();
        _connectLock.Dispose();
        _cts.Dispose();
    }

    private void StartCapture()
    {
        _capture = new WasapiLoopbackCapture();
        _bufferedProvider = new BufferedWaveProvider(_capture.WaveFormat)
        {
            BufferDuration = TimeSpan.FromSeconds(2),
            DiscardOnBufferOverflow = true,
            ReadFully = false
        };

        _capture.DataAvailable += (_, eventArgs) =>
        {
            _bufferedProvider.AddSamples(eventArgs.Buffer, 0, eventArgs.BytesRecorded);
        };

        _capture.RecordingStopped += (_, eventArgs) =>
        {
            if (eventArgs.Exception is not null)
            {
                Console.Error.WriteLine($"[windows-client] capture error: {eventArgs.Exception.Message}");
            }
        };

        ISampleProvider sampleProvider = _bufferedProvider.ToSampleProvider();
        sampleProvider = NormalizeChannels(sampleProvider);

        if (sampleProvider.WaveFormat.SampleRate != AudioConstants.SampleRate)
        {
            sampleProvider = new WdlResamplingSampleProvider(sampleProvider, AudioConstants.SampleRate);
        }

        _pcm16Provider = new SampleToWaveProvider16(sampleProvider);
        _capture.StartRecording();
    }

    private static ISampleProvider NormalizeChannels(ISampleProvider sampleProvider)
    {
        if (sampleProvider.WaveFormat.Channels == 1)
        {
            return new MonoToStereoSampleProvider(sampleProvider);
        }

        if (sampleProvider.WaveFormat.Channels == 2)
        {
            return sampleProvider;
        }

        var multiplex = new MultiplexingSampleProvider([sampleProvider], 2);
        multiplex.ConnectInputToOutput(0, 0);
        multiplex.ConnectInputToOutput(1, 1);
        return multiplex;
    }

    private async Task SendLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await EnsureConnectedAsync(cancellationToken);

                if (_pcm16Provider is null)
                {
                    await Task.Delay(20, cancellationToken);
                    continue;
                }

                var filled = 0;
                while (filled < _sendFrameBuffer.Length && !cancellationToken.IsCancellationRequested)
                {
                    var bytesRead = _pcm16Provider.Read(_sendFrameBuffer, filled, _sendFrameBuffer.Length - filled);
                    if (bytesRead == 0)
                    {
                        await Task.Delay(5, cancellationToken);
                        continue;
                    }

                    filled += bytesRead;
                }

                if (filled < _sendFrameBuffer.Length || _socket?.State != WebSocketState.Open)
                {
                    continue;
                }

                var packet = BuildPacket(_sendFrameBuffer, _sequence++);
                await _socket.SendAsync(packet, WebSocketMessageType.Binary, true, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine($"[windows-client] send loop error: {exception.Message}");
                await Task.Delay(3000, cancellationToken);
            }
        }
    }

    private async Task EnsureConnectedAsync(CancellationToken cancellationToken)
    {
        if (_socket?.State == WebSocketState.Open)
        {
            return;
        }

        await _connectLock.WaitAsync(cancellationToken);
        try
        {
            if (_socket?.State == WebSocketState.Open)
            {
                return;
            }

            _socket?.Dispose();
            _socket = new ClientWebSocket();
            await _socket.ConnectAsync(_options.AudioUri, cancellationToken);
            await SendHelloAsync(cancellationToken);
            _receiveLoop = Task.Run(() => ReceiveLoopAsync(_socket, cancellationToken), cancellationToken);
        }
        finally
        {
            _connectLock.Release();
        }
    }

    private async Task SendHelloAsync(CancellationToken cancellationToken)
    {
        if (_socket is null)
        {
            return;
        }

        var hello = new
        {
            type = "hello",
            deviceId = _options.DeviceId,
            name = _options.Name,
            machineName = Environment.MachineName,
            platform = "windows",
            codec = "pcm_s16le",
            sampleRate = AudioConstants.SampleRate,
            channels = AudioConstants.Channels,
            frameSamples = AudioConstants.FrameSamples
        };

        var json = JsonSerializer.Serialize(hello);
        var payload = Encoding.UTF8.GetBytes(json);
        await _socket.SendAsync(payload, WebSocketMessageType.Text, true, cancellationToken);
    }

    private static async Task ReceiveLoopAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[2048];

        while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            var result = await socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                break;
            }

            if (result.MessageType != WebSocketMessageType.Text)
            {
                continue;
            }

            var message = Encoding.UTF8.GetString(buffer, 0, result.Count);
            Console.WriteLine($"[windows-client] server: {message}");
        }
    }

    private static ArraySegment<byte> BuildPacket(byte[] payload, uint sequence)
    {
        var packet = new byte[payload.Length + 12];
        BitConverter.GetBytes((ulong)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()).CopyTo(packet, 0);
        BitConverter.GetBytes(sequence).CopyTo(packet, 8);
        Buffer.BlockCopy(payload, 0, packet, 12, payload.Length);
        return new ArraySegment<byte>(packet);
    }
}
