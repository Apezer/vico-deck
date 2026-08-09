import { useEffect, useMemo, useRef } from "react";
import {
  OLED_HEIGHT,
  OLED_WIDTH,
  bitmapFromBase64,
  bitmapToBase64,
  renderOledTemplate,
  setBitmapPixel
} from "./oled-bitmap.js";
import { OLED_PIXEL_SCALE, drawPixelFrame } from "./oled-canvas-renderer.js";

function drawLine(bytes, from, to, enabled) {
  let x0 = from.x;
  let y0 = from.y;
  const x1 = to.x;
  const y1 = to.y;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;

  while (true) {
    setBitmapPixel(bytes, x0, y0, enabled);
    if (x0 === x1 && y0 === y1) break;
    const doubled = error * 2;
    if (doubled >= dy) {
      error += dy;
      x0 += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y0 += sy;
    }
  }
}

export default function OledPixelCanvas({ oled, tool, onBitmapChange, previewBitmap = null }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const bytesRef = useRef(null);
  const lastPixelRef = useRef(null);
  const bytes = useMemo(
    () => previewBitmap || (oled.mode === "custom" ? bitmapFromBase64(oled.bitmap) : renderOledTemplate(oled)),
    [oled, previewBitmap]
  );
  const editable = previewBitmap === null && oled.mode === "custom";

  useEffect(() => {
    // 绘制过程中父组件仍可能因性能数据或设备事件重新渲染。
    // 此时保留正在编辑的草稿，避免外部帧覆盖尚未提交的笔画。
    if (drawingRef.current) return;
    bytesRef.current = Uint8Array.from(bytes);
    drawPixelFrame(canvasRef.current, bytesRef.current, oled.brightness);
  }, [bytes, oled.brightness]);

  const locate = (event) => {
    const bounds = canvasRef.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(127, Math.floor((event.clientX - bounds.left) * OLED_WIDTH / bounds.width))),
      y: Math.max(0, Math.min(63, Math.floor((event.clientY - bounds.top) * OLED_HEIGHT / bounds.height)))
    };
  };

  const paint = (event) => {
    if (!drawingRef.current || !editable) return;
    const next = locate(event);
    drawLine(bytesRef.current, lastPixelRef.current || next, next, tool !== "erase");
    lastPixelRef.current = next;
    drawPixelFrame(canvasRef.current, bytesRef.current, oled.brightness);
  };

  const finish = (event, cancelled = false) => {
    if (!drawingRef.current) return;
    if (!cancelled) paint(event);
    drawingRef.current = false;
    lastPixelRef.current = null;
    canvasRef.current.releasePointerCapture?.(event.pointerId);
    // 提交独立副本，避免下一次绘制修改同一缓冲区时污染已保存数据。
    onBitmapChange?.(bitmapToBase64(Uint8Array.from(bytesRef.current)));
  };

  return <div className="oled-device">
    <div className="oled-pixel-screen" style={{ "--oled-brightness": oled.brightness / 100 }}>
      <canvas
        ref={canvasRef}
        className={`oled-pixel-canvas ${editable ? "editable" : ""}`}
        width={OLED_WIDTH * OLED_PIXEL_SCALE}
        height={OLED_HEIGHT * OLED_PIXEL_SCALE}
        onPointerDown={(event) => {
          if (!editable) return;
          drawingRef.current = true;
          lastPixelRef.current = locate(event);
          canvasRef.current.setPointerCapture?.(event.pointerId);
          paint(event);
        }}
        onPointerMove={paint}
        onPointerUp={finish}
        onPointerCancel={(event) => finish(event, true)}
      />
    </div>
  </div>;
}
