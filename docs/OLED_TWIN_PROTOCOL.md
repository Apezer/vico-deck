# Vico OLED Digital Twin Protocol v1

The physical keyboard is the source of truth. VicoDeck renders only complete,
CRC-verified copies of the 128 x 64 framebuffer that the firmware committed to
the SSD1306 display.

## Transport identity

- USB VID/PID: `3343:83CF`
- Product name: `Vico Keyboard`
- HID Usage Page / Usage: `FF00:0001`
- Vendor Report ID: `6`
- Report data length: `63` bytes (the report ID is not included)

The standard keyboard collection and the Vendor collection share the composite
USB device. Keyboard reports keep their normal report ID and are not parsed by
VicoDeck.

## Common report envelope

| Offset | Size | Meaning |
| ---: | ---: | --- |
| 0 | 1 | Command |
| 1 | 1 | Payload length, `0..60` |
| 2 | 60 | Payload followed by zero padding |
| 62 | 1 | XOR of bytes `0..61` |

Multi-byte integers are little-endian.

## Commands

| Direction | Command | Name | Payload |
| --- | ---: | --- | --- |
| Host → device | `01` | `HELLO` | Requested protocol version |
| Host → device | `02` | `DISPLAY_SUBSCRIBE` | `01` subscribe, `00` unsubscribe |
| Device → host | `81` | `HELLO_ACK` | Protocol, width, height, format, firmware version, `VICO` |
| Device → host | `82` | `FRAME_BEGIN` | Frame ID, length, CRC32, format |
| Device → host | `83` | `FRAME_CHUNK` | Frame ID, offset, up to 56 framebuffer bytes |
| Device → host | `84` | `FRAME_END` | Frame ID and CRC32 |

## Frame format

The frame contains exactly 1024 bytes in native Adafruit SSD1306 page-major
layout:

```text
byte index = x + floor(y / 8) * 128
bit mask   = 1 << (y % 8)
```

VicoDeck converts this format into its row-major editor bitmap only after the
complete frame passes all checks.

## Scheduling rules

The firmware captures a frame immediately after the physical `display.display()`
commit, but transmission remains asynchronous:

- Key scanning and keyboard HID reports always run first.
- At most one 63-byte twin report is sent per main-loop pass.
- Reports are spaced by at least 1 ms.
- Only one pending frame is retained; a newer frame replaces an older pending one.
- The frame currently being transmitted uses a private buffer and cannot be mixed
  with a newer OLED update.
- No reports are sent unless USB is mounted and a host has subscribed.

## Connection sequence

```text
VicoDeck                 Firmware
   |---- HELLO ------------>|
   |<--- HELLO_ACK ----------|
   |---- SUBSCRIBE(1) ------>|
   |<--- FRAME_BEGIN --------|
   |<--- FRAME_CHUNK x 19 ---|
   |<--- FRAME_END ----------|
   |    verify CRC + swap    |
```

On disconnect, VicoDeck sends `SUBSCRIBE(0)` when possible. The firmware also
clears the subscription whenever native USB is disconnected.
