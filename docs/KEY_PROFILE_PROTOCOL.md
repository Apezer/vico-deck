# Five-profile key protocol

Vico Keyboard stores five complete profiles in ESP32 NVS. Each profile has
eight compact key bindings. Configuration uses the USB Vendor HID interface;
the selected bindings continue to work in both USB and BLE keyboard modes.

## Binding format

Every binding is exactly five bytes:

| Offset | Field | Values |
|---:|---|---|
| 0 | action | `0` none, `1` keyboard, `2` consumer, `3` Fn |
| 1 | modifiers | bit 0 Ctrl, bit 1 Shift, bit 2 Alt, bit 3 GUI/Win |
| 2 | Arduino keyboard keycode | ASCII or a supported special key |
| 3 | consumer action low byte | internal media action ID |
| 4 | consumer action high byte | internal media action ID |

Consumer action IDs are: previous `1`, play/pause `2`, next `3`, mute `4`,
volume down `5`, volume up `6`, and stop `7`.

## Commands

Commands use the existing 63-byte Vendor HID packet and XOR checksum.
Configuration commands receive `COMMAND_ACK (0x90)` before the desktop sends
the next command.

| Command | Code | Payload |
|---|---:|---|
| `PROFILE_BEGIN` | `0x10` | protocol version, zero-based slot |
| `PROFILE_SET_KEY` | `0x11` | slot, zero-based key, five binding bytes |
| `PROFILE_COMMIT` | `0x12` | slot, activate flag, CRC32 little-endian |
| `PROFILE_SET_ACTIVE` | `0x13` | zero-based slot |
| `PROFILE_ACTIVE_CHANGED` | `0x91` | Device-to-host event containing the active zero-based slot |
| `COMMAND_ACK` | `0x90` | original command, result, slot, active slot |

The CRC32 covers the 40 serialized binding bytes in KEY1-to-KEY8 order.
Firmware writes nothing until all eight bindings and the CRC are valid. A
failed or interrupted transaction therefore leaves the previous NVS profile
intact.

## Identity response

Protocol version 2 appends the profile count, active zero-based profile, and
five little-endian profile CRC32 values to `HELLO_ACK` after the `VICO`
signature. The companion compares these CRC values with its local profiles to
display `已同步` or `未同步` without rewriting flash.

## Local switching

Hold a key mapped to Fn, then press KEY1 through KEY5 to select P1 through P5.
The Fn source and selector are consumed by firmware and never sent to the host.
The OLED briefly displays the newly active profile.

When a profile is selected directly on the keyboard, the firmware queues one
`PROFILE_ACTIVE_CHANGED` event on the USB Vendor HID channel. Events are
coalesced, so rapid local changes report the latest slot without delaying key
scanning. The desktop uses the event to select the matching editable preset.
