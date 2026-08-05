import { drawGfxText } from "./gfx-font.js";

export const OLED_WIDTH = 128;
export const OLED_HEIGHT = 64;
export const OLED_BITMAP_BYTES = (OLED_WIDTH * OLED_HEIGHT) / 8;

export function createBlankBitmap() {
  return new Uint8Array(OLED_BITMAP_BYTES);
}

export function bitmapFromBase64(value) {
  const bytes = createBlankBitmap();
  if (!value) return bytes;

  try {
    const binary = atob(value);
    const length = Math.min(binary.length, bytes.length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
  } catch {
    // Invalid saved data is treated as a blank canvas.
  }
  return bytes;
}

export function bitmapToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < OLED_BITMAP_BYTES; index += 1) {
    binary += String.fromCharCode(bytes[index] || 0);
  }
  return btoa(binary);
}

export function getBitmapPixel(bytes, x, y) {
  if (x < 0 || x >= OLED_WIDTH || y < 0 || y >= OLED_HEIGHT) return false;
  const byteIndex = y * (OLED_WIDTH / 8) + (x >> 3);
  return (bytes[byteIndex] & (0x80 >> (x & 7))) !== 0;
}

export function setBitmapPixel(bytes, x, y, enabled) {
  if (x < 0 || x >= OLED_WIDTH || y < 0 || y >= OLED_HEIGHT) return;
  const byteIndex = y * (OLED_WIDTH / 8) + (x >> 3);
  const mask = 0x80 >> (x & 7);
  if (enabled) bytes[byteIndex] |= mask;
  else bytes[byteIndex] &= ~mask;
}

/** Convert Adafruit SSD1306 page-major bytes into the editor's row-major bitmap. */
export function ssd1306PageBufferToBitmap(pageBuffer) {
  const bitmap = createBlankBitmap();
  if (!pageBuffer || pageBuffer.length !== OLED_BITMAP_BYTES) return bitmap;

  for (let y = 0; y < OLED_HEIGHT; y += 1) {
    for (let x = 0; x < OLED_WIDTH; x += 1) {
      const pageByte = pageBuffer[x + Math.floor(y / 8) * OLED_WIDTH];
      setBitmapPixel(bitmap, x, y, (pageByte & (1 << (y & 7))) !== 0);
    }
  }
  return bitmap;
}

export function invertBitmap(bytes) {
  const result = Uint8Array.from(bytes);
  for (let index = 0; index < result.length; index += 1) {
    result[index] ^= 0xff;
  }
  return result;
}

function fillBitmapRect(bytes, x, y, width, height) {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      setBitmapPixel(bytes, column, row, true);
    }
  }
}

function drawBitmapRect(bytes, x, y, width, height) {
  fillBitmapRect(bytes, x, y, width, 1);
  fillBitmapRect(bytes, x, y + height - 1, width, 1);
  fillBitmapRect(bytes, x, y, 1, height);
  fillBitmapRect(bytes, x + width - 1, y, 1, height);
}

function drawBitmapLine(bytes, startX, startY, endX, endY) {
  let x = startX;
  let y = startY;
  const dx = Math.abs(endX - startX);
  const sx = startX < endX ? 1 : -1;
  const dy = -Math.abs(endY - startY);
  const sy = startY < endY ? 1 : -1;
  let error = dx + dy;

  while (true) {
    setBitmapPixel(bytes, x, y, true);
    if (x === endX && y === endY) return;
    const doubled = error * 2;
    if (doubled >= dy) {
      error += dy;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y += sy;
    }
  }
}

function imageDataToBitmap(imageData, alphaAsMask = false) {
  const bytes = createBlankBitmap();
  for (let y = 0; y < OLED_HEIGHT; y += 1) {
    for (let x = 0; x < OLED_WIDTH; x += 1) {
      const index = (y * OLED_WIDTH + x) * 4;
      const alpha = imageData.data[index + 3];
      const luminance =
        imageData.data[index] * 0.2126 +
        imageData.data[index + 1] * 0.7152 +
        imageData.data[index + 2] * 0.0722;
      setBitmapPixel(
        bytes,
        x,
        y,
        alphaAsMask ? alpha > 96 : alpha > 40 && luminance >= 96
      );
    }
  }
  return bytes;
}

export function renderOledTemplate(oled) {
  if (oled.mode === "custom") return bitmapFromBase64(oled.bitmap);
  const bitmap = createBlankBitmap();

  if (oled.mode === "minimal") {
    drawGfxText(bitmap, "Vico ESP32-S3", 0, 0);
    drawGfxText(bitmap, "P1", 84, 0);
    drawGfxText(bitmap, "USB", 104, 0);
    fillBitmapRect(bitmap, 0, 12, OLED_WIDTH, 1);

    const labels = ["<", "DN", ">", "ENT", "BSP", "UP", "C+W", "FN"];
    const boxWidth = 28;
    const boxHeight = 14;
    const gap = 2;
    const startX = 4;
    const startY = 18;

    labels.forEach((label, index) => {
      const x = startX + (index % 4) * (boxWidth + gap);
      const y = startY + Math.floor(index / 4) * (boxHeight + gap);
      drawBitmapRect(bitmap, x, y, boxWidth, boxHeight);
      const labelWidth = label.length * 6;
      drawGfxText(bitmap, label, x + Math.floor((boxWidth - labelWidth) / 2), y + 3);
    });

    drawGfxText(bitmap, "18 17 16 15 5 6 7 4", 0, 54);
    return bitmap;
  }

  if (oled.showConnection) {
    drawGfxText(bitmap, "USB", 1, 1);
  }
  if (oled.showBattery) {
    drawGfxText(bitmap, "86%", 108, 1);
  }
  fillBitmapRect(bitmap, 0, 10, OLED_WIDTH, 1);

  if (oled.mode === "stats") {
    drawGfxText(bitmap, "72 WPM", 4, 15, 2);
    drawGfxText(bitmap, "KEYS 1,284", 5, 36);
    [8, 19, 12, 25, 16].forEach((height, index) => {
      fillBitmapRect(bitmap, 77 + index * 9, 53 - height, 6, height);
    });
  } else {
    drawGfxText(bitmap, oled.title || "VICO", 4, 15, 2);
    drawGfxText(bitmap, oled.subtitle || "CREATE YOUR FLOW", 5, 40);
    const points = [[83, 28], [90, 23], [97, 32], [104, 20], [111, 29], [124, 22]];
    for (let index = 1; index < points.length; index += 1) {
      drawBitmapLine(
        bitmap,
        points[index - 1][0],
        points[index - 1][1],
        points[index][0],
        points[index][1]
      );
    }
  }

  return bitmap;
}

export function importImageBitmap(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = OLED_WIDTH;
        canvas.height = OLED_HEIGHT;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.imageSmoothingEnabled = true;

        const scale = Math.min(OLED_WIDTH / image.width, OLED_HEIGHT / image.height);
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const x = Math.floor((OLED_WIDTH - width) / 2);
        const y = Math.floor((OLED_HEIGHT - height) / 2);
        context.drawImage(image, x, y, width, height);
        const imageData = context.getImageData(0, 0, OLED_WIDTH, OLED_HEIGHT);
        const hasTransparency = imageData.data.some(
          (value, index) => index % 4 === 3 && value < 250
        );
        let bitmap = imageDataToBitmap(imageData, hasTransparency);

        if (!hasTransparency) {
          let enabledPixels = 0;
          for (const byte of bitmap) {
            enabledPixels += byte.toString(2).replaceAll("0", "").length;
          }
          if (enabledPixels > OLED_WIDTH * OLED_HEIGHT / 2) {
            bitmap = invertBitmap(bitmap);
          }
        }
        resolve(bitmap);
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取这张图片"));
    };
    image.src = url;
  });
}
