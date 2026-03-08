# Home Audio Hub

Домашний аудио-хаб, который принимает системный звук с нескольких устройств, микширует его на центральном сервере и управляется через веб-панель.

## Архитектура

### Поток данных

1. Клиент на устройстве захватывает системное аудио.
2. Клиент нормализует поток к `48kHz / stereo / PCM s16le`.
3. Клиент отправляет на сервер бинарные WebSocket-фреймы:
   - `8 bytes` `captureTimeMs`
   - `4 bytes` `sequence`
   - `3840 bytes` PCM payload (`20ms`)
4. Сервер складывает фреймы в jitter-буферы по источникам.
5. Микшер сервера каждые `20ms` смешивает активные источники с учётом `volume` и `mute`.
6. Итоговый поток отправляется в локальное устройство вывода:
   - Linux: через `ffmpeg` в PulseAudio/PipeWire sink
   - Windows: через `ffplay` в системное устройство по умолчанию
7. Веб-панель получает состояние через Socket.IO и применяет изменения громкости мгновенно.

### Компоненты

- `server/`: Node.js сервер, микшер, панель управления, output manager.
- `clients/windows/`: .NET клиент с `NAudio` и `WasapiLoopbackCapture`.
- `clients/linux/`: Node.js клиент с FFmpeg и PulseAudio monitor-source.
- `clients/android/`: Kotlin Android-клиент на `MediaProjection` + `AudioPlaybackCapture`.

## Структура проекта

```text
.
├── clients
│   ├── android
│   ├── linux
│   └── windows
├── server
│   ├── public
│   └── src
└── README.md
```

## Ограничения и допущения

- Текущая серверная реализация использует `PCM s16le` ради предсказуемого микширования и минимальной сложности на сервере. Для production-сети с большим числом клиентов стоит перейти на `Opus` на канале передачи и декодировать на edge-процессе сервера.
- Полноценный выбор выходного устройства реализован для Linux через PulseAudio/PipeWire. На Windows в текущем коде вывод идёт в default output.
- Android не умеет снимать "весь системный звук" с любых приложений без ограничений. Начиная с Android 10 доступен только `AudioPlaybackCapture`, и только для приложений, которые не запретили захват.
- Текущий Android-клиент сделан как MVP внутри `Activity`. Для production-варианта захват через `MediaProjection` лучше переносить в foreground service.

## Быстрый запуск

### 1. Сервер

Требования:

- Node.js 20+
- FFmpeg в `PATH`
- Linux: `pactl` и PulseAudio/PipeWire

Запуск:

```bash
cd server
npm install
npm start
```

Панель управления:

```text
http://<SERVER_IP>:4010
```

### 2. Linux-клиент

Требования:

- Node.js 20+
- FFmpeg
- `pactl`

Запуск:

```bash
cd clients/linux
npm install
node src/index.js --server http://<SERVER_IP>:4010 --name Laptop
```

Опционально можно указать Pulse source:

```bash
node src/index.js --server http://<SERVER_IP>:4010 --name Laptop --source alsa_output.pci-0000_00_1f.3.analog-stereo.monitor
```

### 3. Windows-клиент

Требования:

- .NET SDK 8.0+

Запуск:

```powershell
cd clients/windows/AudioHub.WindowsClient
dotnet restore
dotnet run -- --server http://<SERVER_IP>:4010 --name PC
```

### 4. Android-клиент

Требования:

- Android Studio
- Android 10+ устройство

Запуск:

1. Открыть каталог `clients/android` в Android Studio.
2. Собрать и установить приложение на телефон.
3. Указать адрес сервера и нажать `Start capture`.
4. Разрешить `MediaProjection`.

## Панель управления

Веб-панель показывает:

- подключенные устройства
- онлайн/offline статус
- активность воспроизведения
- текущую громкость
- очередь/jitter и расчётную задержку
- выбор устройства вывода

Изменения громкости и `mute` уходят через Socket.IO и применяются на следующем микшерном тике.

## Улучшения для production

- Переключить передачу с PCM на `Opus` с packet loss concealment.
- Вынести аудиомикшер в native/Rust worker или в `FFmpeg filtergraph`, если понадобится больше источников.
- Добавить persist-конфиг профилей устройств и авторизацию панели.
- Добавить AEC/ducking-политику для приоритетных источников.
- Ввести отдельный discovery-сервис через mDNS.
- Добавить запись mixed bus и replay buffer.

## Оптимизация задержки

- Держать размер фрейма `20ms` или `10ms`, если CPU позволяет.
- Использовать Wi‑Fi 5GHz или Ethernet для сервера.
- Не пересэмплировать поток на сервере, а нормализовать формат на клиентах.
- Ограничить `jitterTargetFrames` до `2-3` в стабильной сети.
- Привязать сервер к Linux + PipeWire/PulseAudio, где проще контролировать sink и меньше сюрпризов с драйверами.
- При переходе на Opus использовать constrained VBR, маленький packet size и FEC.

## Синхронизация потоков

Базовая схема в коде:

- каждый аудиофрейм содержит `captureTimeMs`
- сервер считает фактическую задержку по `now - captureTimeMs`
- каждый источник проходит через небольшой jitter buffer
- переполненные очереди подрезаются, чтобы не расти по latency

Рекомендуемая production-схема:

1. Синхронизировать часы клиентов по NTP или PTP внутри LAN.
2. Передавать не только `captureTime`, но и `sampleClock`.
3. На сервере держать целевую временную метку воспроизведения `playoutTime`.
4. Для ранних пакетов держать ожидание, для поздних дропать фреймы.
5. Для долгого дрейфа применять micro time-stretch/resampling на источник, а не скачкообразные дропы.

## Рекомендуемая серверная ОС

Для этой задачи лучший основной вариант: Linux-сервер с PipeWire/PulseAudio.

Причины:

- проще выбрать конкретный Bluetooth sink
- проще получить monitor/output topology
- меньше ограничений на локальный audio routing
- легче автоматизировать запуск как service
