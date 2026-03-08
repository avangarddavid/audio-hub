# Architecture Notes

## Control plane

- HTTP/Express раздаёт панель и health endpoints.
- Socket.IO обслуживает dashboard и low-latency control events.
- Стейт управления хранится в `DeviceRegistry`.

## Audio plane

- Аудио идёт не через Socket.IO, а через отдельный raw WebSocket endpoint `/audio`.
- Каждый клиент сначала посылает `hello`, затем бинарные фреймы фиксированного размера.
- Сервер не декодирует контейнеры, а получает уже нормализованный PCM для предсказуемого mixing path.

## Why PCM now

Для MVP это даёт:

- простую реализацию микшера на сервере
- быстрые мгновенные изменения громкости
- отсутствие runtime-зависимости на decode worker
- удобную отладку и воспроизводимость

Цена:

- больше трафика в LAN

При 48kHz/stereo/16-bit это около `1.536 Mbps` на источник, что для домашней Wi‑Fi сети обычно допустимо при небольшом числе устройств.

## Future codec path

Если потребуется сжимать трафик:

1. Клиенты кодируют `Opus 48kHz`.
2. Edge worker на сервере декодирует в PCM.
3. Internal mix bus остаётся PCM.
4. Output stage остаётся без изменений.

Такой путь сохраняет текущую архитектуру control plane и mixer API.
