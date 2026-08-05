# OLED bitmap protocol

VicoDeck converts every OLED layout into the exact framebuffer shown by the desktop preview before sending it to the keyboard.

## Frame format

- Resolution: `128 × 64`
- Color depth: `1 bit`
- Frame size: `128 × 64 ÷ 8 = 1024 bytes`
- Byte order: row-major
- Bit order inside each byte: most-significant bit first

Pixel `(x, y)` is stored as:

```cpp
uint16_t index = y * 16 + (x >> 3);
uint8_t mask = 0x80 >> (x & 7);
bool enabled = (frame[index] & mask) != 0;
```

This layout can be passed directly to Adafruit GFX:

```cpp
display.clearDisplay();
display.drawBitmap(0, 0, frame, 128, 64, SSD1306_WHITE);
display.display();
```

## WebHID packets

VicoDeck uses 64-byte HID reports:

| Byte | Meaning |
|---|---|
| `0` | Command |
| `1` | Payload length, maximum 61 |
| `2..62` | Payload |
| `63` | XOR checksum of bytes `0..62` |

### OLED metadata — `0x20`

Payload:

| Offset | Meaning |
|---|---|
| `0` | Protocol version (`1`) |
| `1` | Width (`128`) |
| `2` | Height (`64`) |
| `3` | Brightness (`0..100`) |
| `4` | Format (`1`: row-major 1-bit MSB first) |
| `5..6` | Frame size, little-endian (`1024`) |

The firmware should clear its temporary 1024-byte receive buffer after accepting this command.

### OLED bitmap chunk — `0x21`

Payload:

| Offset | Meaning |
|---|---|
| `0..1` | Destination byte offset, little-endian |
| `2..60` | Up to 59 bitmap bytes |

A full frame needs 18 chunk reports.

### Commit — `0x30`

After all chunks have arrived, `COMMIT` tells the firmware to validate and store the completed frame. Recommended firmware behavior:

1. Confirm all 1024 bytes were received.
2. Copy the frame to NVS, LittleFS, or a dedicated flash partition.
3. Update SSD1306 brightness.
4. Call `drawBitmap()` and `display()`.
5. Preserve the last valid frame if transfer validation fails.

## Imported images

PNG, JPEG, WebP, and BMP files are scaled proportionally into a 128×64 canvas, centered, converted to luminance, thresholded to one bit, and then stored in the same framebuffer format. High-contrast PNG artwork produces the best results.
