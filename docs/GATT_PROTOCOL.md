# VicoDeck BLE GATT Protocol

VicoDeck 0.2.x uses the ESP32-S3 firmware's custom status service alongside the standard BLE HID keyboard service.

## UUIDs

| Name | UUID | Properties |
| --- | --- | --- |
| Status Service | `7b6a0001-7c6e-4b3d-9f5f-7669636f0001` | Primary service |
| RX | `7b6a0002-7c6e-4b3d-9f5f-7669636f0002` | Write, Write Without Response |
| TX | `7b6a0003-7c6e-4b3d-9f5f-7669636f0003` | Read, Notify |

## Status write

The desktop app writes compact UTF-8 JSON to RX:

```json
{"state":"tool","tool":"Bash","text":"Running Bash"}
```

Current field limits:

| Field | Maximum | Notes |
| --- | ---: | --- |
| `state` | 8 characters | `ready`, `working`, `tool`, `waiting`, `done`, `error`, `offline` |
| `tool` | 14 characters | Printable ASCII |
| `text` | 42 characters | Printable ASCII |

## Acknowledgement

Firmware may notify TX after a successful write:

```json
{"ok":true,"state":"tool","text":"Running Bash"}
```

## Compatibility

The BLE device name must start with `Vico Keyboard`. The service may be used at the same time as the standard HID service when the firmware continues advertising for a second GATT client.

## Planned protocol

Future versions will introduce versioned operations for:

- Device and firmware information
- Reading and writing all eight key mappings
- OLED layouts and bitmap assets
- RGB effects
- NVS commit and factory reset
- Chunking and checksums
