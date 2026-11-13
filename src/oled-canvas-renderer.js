import { OLED_HEIGHT, OLED_WIDTH, getBitmapPixel } from "./oled-bitmap.js";

export const OLED_PIXEL_SCALE = 4;

/** 绘制一张 128×64 的行优先位图，不使用浏览器字体渲染。 */
export function drawPixelFrame(canvas, bytes, brightness = 100) {
  if (!canvas || !bytes || typeof canvas.getContext !== "function") return false;
  const context = canvas.getContext("2d");
  if (!context) return false;

  try {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#010302";
    context.fillRect(0, 0, canvas.width, canvas.height);

    const safeBrightness = Number.isFinite(Number(brightness))
      ? Math.max(0, Math.min(100, Number(brightness)))
      : 100;
    const intensity = 0.35 + safeBrightness / 100 * 0.65;
    context.fillStyle = `rgb(${Math.round(220 * intensity)}, ${Math.round(255 * intensity)}, ${Math.round(81 * intensity)})`;

    for (let y = 0; y < OLED_HEIGHT; y += 1) {
      for (let x = 0; x < OLED_WIDTH; x += 1) {
        if (getBitmapPixel(bytes, x, y)) {
          context.fillRect(
            x * OLED_PIXEL_SCALE,
            y * OLED_PIXEL_SCALE,
            OLED_PIXEL_SCALE,
            OLED_PIXEL_SCALE
          );
        }
      }
    }
    return true;
  } catch (error) {
    console.error("OLED Canvas rendering failed", error);
    return false;
  }
}
