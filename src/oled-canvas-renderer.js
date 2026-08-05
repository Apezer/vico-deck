import { OLED_HEIGHT, OLED_WIDTH, getBitmapPixel } from "./oled-bitmap.js";

export const OLED_PIXEL_SCALE = 4;

/** 绘制一张 128×64 的行优先位图，不使用浏览器字体渲染。 */
export function drawPixelFrame(canvas, bytes, brightness = 100) {
  if (!canvas || !bytes) return;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#010302";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const intensity = 0.35 + brightness / 100 * 0.65;
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
}
