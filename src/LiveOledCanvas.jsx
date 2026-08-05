import { useEffect, useMemo, useRef } from "react";
import {
  OLED_HEIGHT,
  OLED_WIDTH,
  renderOledTemplate,
  ssd1306PageBufferToBitmap
} from "./oled-bitmap.js";
import { OLED_PIXEL_SCALE, drawPixelFrame } from "./oled-canvas-renderer.js";

/**
 * Pixel-accurate device mirror. Live frames are decoded from the physical
 * SSD1306 byte layout; the fallback frame is clearly marked as simulated.
 */
export default function LiveOledCanvas({ frame, connected }) {
  const canvasRef = useRef(null);
  const bitmap = useMemo(
    () => frame?.bytes
      ? ssd1306PageBufferToBitmap(frame.bytes)
      : renderOledTemplate({ mode: "minimal" }),
    [frame]
  );

  useEffect(() => {
    drawPixelFrame(canvasRef.current, bitmap, 100);
  }, [bitmap]);

  const live = connected && Boolean(frame?.bytes);
  return <div className={`live-oled ${live ? "is-live" : "is-simulated"}`}>
    <div className="live-oled-meta">
      <span>{live ? "LIVE · DEVICE FRAME" : "SIMULATED · WAITING FOR DEVICE"}</span>
      {live && <small>FRAME {frame.sequence}</small>}
    </div>
    <canvas
      ref={canvasRef}
      width={OLED_WIDTH * OLED_PIXEL_SCALE}
      height={OLED_HEIGHT * OLED_PIXEL_SCALE}
      aria-label={live ? "键盘 OLED 实时画面" : "键盘 OLED 离线模拟画面"}
    />
  </div>;
}
