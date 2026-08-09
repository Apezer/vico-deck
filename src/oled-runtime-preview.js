import { drawGfxText } from "./gfx-font.js";
import { createBlankBitmap, setBitmapPixel } from "./oled-bitmap.js";

const PAGE_LABELS = Object.freeze({
  brand: "品牌",
  claude: "Coding",
  system: "性能",
  clock: "时钟",
  device: "键盘",
  custom: "自定义像素画"
});

const CLAUDE_LOGO_32X16 = Uint8Array.from([
  0x00,0x00,0x00,0x00, 0x03,0xff,0xff,0xc0, 0x03,0xff,0xff,0xc0, 0x03,0xff,0xff,0xc0,
  0x03,0x9f,0xf9,0xc0, 0x03,0x9f,0xf9,0xc0, 0x03,0x9f,0xf9,0xc0, 0x1f,0xff,0xff,0xf8,
  0x1f,0xff,0xff,0xf8, 0x0f,0xff,0xff,0xf0, 0x03,0xff,0xff,0xc0, 0x03,0xff,0xff,0xc0,
  0x00,0x90,0x09,0x00, 0x00,0x90,0x09,0x00, 0x00,0x90,0x09,0x00, 0x00,0x00,0x00,0x00
]);

const CLAUDE_STATE_DISPLAY = Object.freeze({
  ready:"READY", working:"THINK", tool:"TOOL", waiting:"INPUT",
  done:"DONE", error:"ERROR", offline:"OFFLINE"
});

const CLAUDE_ACTIVITY_HINT = Object.freeze({
  ready:"WAITING FOR PROMPT", working:"CLAUDE IS THINKING", tool:"RUNNING TOOL",
  waiting:"USER INPUT NEEDED", done:"TASK FINISHED", error:"CHECK CLAUDE LOG",
  offline:"START CLAUDE CODE"
});

export const OLED_CONTENT_OPTIONS = Object.entries(PAGE_LABELS);

function fillRect(bitmap, x, y, width, height) {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      setBitmapPixel(bitmap, column, row, true);
    }
  }
}

function drawRect(bitmap, x, y, width, height) {
  fillRect(bitmap, x, y, width, 1);
  fillRect(bitmap, x, y + height - 1, width, 1);
  fillRect(bitmap, x, y, 1, height);
  fillRect(bitmap, x + width - 1, y, 1, height);
}

function drawLine(bitmap, startX, startY, endX, endY) {
  let x = startX;
  let y = startY;
  const dx = Math.abs(endX - startX);
  const sx = startX < endX ? 1 : -1;
  const dy = -Math.abs(endY - startY);
  const sy = startY < endY ? 1 : -1;
  let error = dx + dy;

  while (true) {
    setBitmapPixel(bitmap, x, y, true);
    if (x === endX && y === endY) break;
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

function drawRowBitmap(bitmap, source, x, y, width, height) {
  const bytesPerRow = Math.ceil(width / 8);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const enabled = (source[row * bytesPerRow + Math.floor(column / 8)] & (0x80 >> (column % 8))) !== 0;
      if (enabled) setBitmapPixel(bitmap, x + column, y + row, true);
    }
  }
}

function drawOrbitPixel(bitmap, position) {
  const x = 94, y = 11, width = 34, height = 20;
  if (position < width) setBitmapPixel(bitmap, x + position, y, true);
  else if (position < width + height - 1) setBitmapPixel(bitmap, x + width - 1, y + position - width + 1, true);
  else if (position < width * 2 + height - 2) setBitmapPixel(bitmap, x + width - 2 - (position - width - height + 1), y + height - 1, true);
  else setBitmapPixel(bitmap, x, y + height - 2 - (position - width * 2 - height + 2), true);
}

function batteryLabel(percent) {
  return Number.isFinite(percent)
    ? `${String(Math.max(0, Math.min(100, Math.round(percent)))).padStart(3, " ")}%`
    : " --%";
}

function header(bitmap, title, batteryPercent) {
  drawGfxText(bitmap, title, 0, 0);
  drawGfxText(bitmap, batteryLabel(batteryPercent), 104, 0);
  fillRect(bitmap, 0, 10, 128, 1);
}

function metric(bitmap, label, value, y) {
  const known = Number.isFinite(value);
  const safeValue = known ? Math.max(0, Math.min(100, Math.round(value))) : null;
  drawGfxText(bitmap, label, 0, y);
  drawGfxText(bitmap, safeValue === null ? " --" : String(safeValue).padStart(3, " "), 24, y);
  drawRect(bitmap, 47, y, 80, 8);
  if (safeValue > 0) fillRect(bitmap, 49, y + 2, Math.floor(safeValue * 76 / 100), 4);
}

function asciiLabel(value, fallback, maximum = 16) {
  return String(value || fallback).replace(/[^\x20-\x7e]/g, " ").trim().slice(0, maximum) || fallback;
}

function renderBrand(bitmap, connectionMode, batteryPercent) {
  drawGfxText(bitmap, connectionMode, 1, 1);
  drawGfxText(bitmap, batteryLabel(batteryPercent), 104, 1);
  fillRect(bitmap, 0, 10, 128, 1);
  drawGfxText(bitmap, "VICO", 4, 15, 2);
  drawGfxText(bitmap, "CREATE YOUR FLOW", 5, 40);

  const points = [[83, 28], [90, 23], [97, 32], [104, 20], [111, 29], [124, 22]];
  for (let index = 1; index < points.length; index += 1) {
    drawLine(bitmap, points[index - 1][0], points[index - 1][1], points[index][0], points[index][1]);
  }
}

function renderClaude(bitmap, claudeStatus, connectionMode, batteryPercent, now) {
  const state = claudeStatus?.state || "offline";
  drawGfxText(bitmap, "CLAUDE CODE", 0, 0);
  drawGfxText(bitmap, connectionMode, 82, 0);
  drawGfxText(bitmap, batteryLabel(batteryPercent), 104, 0);
  fillRect(bitmap, 0, 9, 128, 1);

  drawGfxText(bitmap, CLAUDE_STATE_DISPLAY[state] || "OFFLINE", 0, 14, 2);
  drawRowBitmap(bitmap, CLAUDE_LOGO_32X16, 96, 13, 32, 16);
  if (state === "working") {
    const perimeter = 2 * (34 + 20) - 4;
    const frame = (Math.floor(now.getTime() / 180) * 6) % perimeter;
    for (let index = 0; index < 14; index += 1) drawOrbitPixel(bitmap, (frame + index) % perimeter);
  }
  fillRect(bitmap, 0, 32, 128, 1);

  const tool = asciiLabel(claudeStatus?.tool, "", 15);
  drawGfxText(bitmap, tool ? `TOOL ${tool}` : CLAUDE_ACTIVITY_HINT[state] || CLAUDE_ACTIVITY_HINT.offline, 0, 35);
  drawGfxText(bitmap, asciiLabel(claudeStatus?.text, "Waiting for task", 21), 0, 45);

  const sessions = Math.max(0, Number(claudeStatus?.activeSessions) || (state === "offline" ? 0 : 1));
  if (sessions > 0) {
    const age = Math.max(0, Math.floor((now.getTime() - Number(claudeStatus?.updatedAt || now.getTime())) / 1000));
    drawGfxText(bitmap, `S:${sessions}  LAST ${String(Math.floor(age / 60)).padStart(2, "0")}:${String(age % 60).padStart(2, "0")}`, 0, 55);
  } else {
    drawGfxText(bitmap, "HOOK READY", 0, 55);
  }
}

function renderSystem(bitmap, systemStatus, batteryPercent, now) {
  header(bitmap, "SYSTEM MONITOR", batteryPercent);
  const online = systemStatus?.online !== false;
  metric(bitmap, "CPU", online ? systemStatus?.cpu : null, 15);
  metric(bitmap, "GPU", online ? systemStatus?.gpu : null, 28);
  metric(bitmap, "RAM", online ? systemStatus?.memory : null, 41);
  const temperature = Number.isFinite(systemStatus?.temperature)
    ? `TEMP ${Math.round(systemStatus.temperature)}C`
    : online ? "TEMP --" : "PC OFFLINE";
  drawGfxText(bitmap, temperature, 0, 55);
  drawGfxText(bitmap, `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`, 98, 55);
}

function renderClock(bitmap, batteryPercent, now) {
  header(bitmap, "CLOCK", batteryPercent);
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  drawGfxText(bitmap, time, 18, 17, 3);
  drawGfxText(
    bitmap,
    `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}  ${weekdays[now.getDay()]}`,
    29,
    50
  );
}

function renderDevice(bitmap, profileSlot, connected, batteryPercent, batteryMillivolts) {
  drawGfxText(bitmap, "Vico ESP32-S3", 0, 0);
  drawGfxText(bitmap, `P${profileSlot + 1}`, 84, 0);
  drawGfxText(bitmap, connected ? "USB" : "...", 104, 0);
  fillRect(bitmap, 0, 12, 128, 1);
  const labels = ["<", "DN", ">", "ENT", "BSP", "UP", "C+W", "FN"];
  labels.forEach((label, index) => {
    const x = 4 + (index % 4) * 30;
    const y = 18 + Math.floor(index / 4) * 16;
    drawRect(bitmap, x, y, 28, 14);
    drawGfxText(bitmap, label, x + Math.floor((28 - label.length * 6) / 2), y + 3);
  });
  const voltage = Number.isFinite(batteryMillivolts) ? `  ${Math.round(batteryMillivolts)}MV` : "";
  drawGfxText(bitmap, `BAT ${batteryLabel(batteryPercent).trim()}${voltage}`, 0, 54);
}

/** 以与固件相同的 128×64 像素坐标生成软件端实时预览。 */
export function renderRuntimePreview({ page, systemStatus, claudeStatus, profileSlot = 0, connected = false, connectionMode, batteryPercent, batteryMillivolts, now = new Date() }) {
  const bitmap = createBlankBitmap();
  const resolvedConnectionMode = connectionMode || (connected ? "USB" : "ADV");
  if (page === "claude") renderClaude(bitmap, claudeStatus, resolvedConnectionMode, batteryPercent, now);
  else if (page === "system") renderSystem(bitmap, systemStatus, batteryPercent, now);
  else if (page === "clock") renderClock(bitmap, batteryPercent, now);
  else if (page === "device") renderDevice(bitmap, profileSlot, connected, batteryPercent, batteryMillivolts);
  else renderBrand(bitmap, resolvedConnectionMode, batteryPercent);
  return bitmap;
}
