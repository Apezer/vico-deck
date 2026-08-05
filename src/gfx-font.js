// Adafruit GFX classic glcdfont.c, ASCII 0x20..0x7E, 5 bytes per glyph.
// The source bytes are identical to the firmware's Adafruit GFX dependency.
const FONT_BASE64 =
  "AAAAAAAAAF8AAAAHAAcAFH8UfxQkKn8qEiMTCGRiNklWIFAACAcDAAAcIkEAAEEiHAAqHH8cKggIPggIAIBwMAAICAgICAAAYGAAIBAIBAI+UUlFPgBCf0AAcklJSUYhQUlNMxgUEn8QJ0VFRTk8SklJMUEhEQkHNklJSTZGSUkpHgAAFAAAAEA0AAAACBQiQRQUFBQUAEEiFAgCAVkJBj5BXVlOfBIREnx/SUlJNj5BQUEif0FBQT5/SUlJQX8JCQkBPkFBUXN/CAgIfwBBf0EAIEBBPwF/CBQiQX9AQEBAfwIcAn9/BAgQfz5BQUE+fwkJCQY+QVEhXn8JGSlGJklJSTIDAX8BAz9AQEA/HyBAIB8/QDhAP2MUCBRjAwR4BANhWUlNQwB/QUFBAgQIECAAQUFBfwQCAQIEQEBAQEAAAwcIACBUVHhAfyhERDg4REREKDhERCh/OFRUVBgACH4JAhikpJx4fwgEBHgARH1AACBAQD0AfxAoRAAAQX9AAHwEeAR4fAgEBHg4REREOPwYJCQYGCQkGPx8CAQECEhUVFQkBAQ/RCQ8QEAgfBwgQCAcPEAwQDxEKBAoREyQkJB8RGRUTEQACDZBAAAAdwAAAEE2CAACAQIEAg==";

let cachedFont;

function setPixel(bitmap, x, y) {
  if (x < 0 || x >= 128 || y < 0 || y >= 64) return;
  const byteIndex = y * 16 + (x >> 3);
  bitmap[byteIndex] |= 0x80 >> (x & 7);
}

function fontBytes() {
  if (!cachedFont) {
    const binary = atob(FONT_BASE64);
    cachedFont = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  return cachedFont;
}

export function drawGfxChar(bitmap, x, y, character, size = 1) {
  const code = character.charCodeAt(0);
  if (code < 0x20 || code > 0x7e) return;
  const font = fontBytes();
  const glyphOffset = (code - 0x20) * 5;

  for (let column = 0; column < 5; column += 1) {
    let line = font[glyphOffset + column];
    for (let row = 0; row < 8; row += 1) {
      if (line & 1) {
        for (let scaleY = 0; scaleY < size; scaleY += 1) {
          for (let scaleX = 0; scaleX < size; scaleX += 1) {
            setPixel(bitmap, x + column * size + scaleX, y + row * size + scaleY);
          }
        }
      }
      line >>= 1;
    }
  }
}

export function drawGfxText(bitmap, text, x, y, size = 1, wrap = true) {
  let cursorX = x;
  let cursorY = y;

  for (const character of String(text)) {
    if (character === "\n") {
      cursorX = 0;
      cursorY += size * 8;
      continue;
    }
    if (character === "\r") continue;

    if (wrap && cursorX + size * 6 > 128) {
      cursorX = 0;
      cursorY += size * 8;
    }
    drawGfxChar(bitmap, cursorX, cursorY, character, size);
    cursorX += size * 6;
  }

  return { x: cursorX, y: cursorY };
}
