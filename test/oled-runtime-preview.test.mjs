import assert from "node:assert/strict";
import { renderRuntimePreview } from "../src/oled-runtime-preview.js";

function enabledBytes(bitmap) {
  return bitmap.reduce((total, byte) => total + (byte === 0 ? 0 : 1), 0);
}

const common = {
  profileSlot:0,
  connected:true,
  batteryPercent:72,
  batteryMillivolts:3928,
  claudeStatus:{ state:"working", tool:"Read" },
  systemStatus:{ cpu:25, gpu:50, memory:75, temperature:null, online:true },
  now:new Date(2026, 7, 6, 14, 26)
};

const pages = ["brand", "claude", "system", "clock", "device", "animation"]
  .map((page) => renderRuntimePreview({ ...common, page }));

for (const bitmap of pages) {
  assert.equal(bitmap.length, 1024);
  assert.ok(enabledBytes(bitmap) > 0);
}

assert.notDeepEqual(pages[0], pages[1]);
assert.notDeepEqual(pages[1], pages[2]);

const lowCpu = renderRuntimePreview({ ...common, page:"system", systemStatus:{ ...common.systemStatus, cpu:5 } });
const highCpu = renderRuntimePreview({ ...common, page:"system", systemStatus:{ ...common.systemStatus, cpu:95 } });
assert.notDeepEqual(lowCpu, highCpu);

const lowBattery = renderRuntimePreview({ ...common, page:"brand", batteryPercent:12 });
const highBattery = renderRuntimePreview({ ...common, page:"brand", batteryPercent:98 });
assert.notDeepEqual(lowBattery, highBattery);

const thinkingFrameA = renderRuntimePreview({ ...common, page:"claude", now:new Date(2026, 7, 6, 14, 26, 0, 0) });
const thinkingFrameB = renderRuntimePreview({ ...common, page:"claude", now:new Date(2026, 7, 6, 14, 26, 0, 180) });
assert.notDeepEqual(thinkingFrameA, thinkingFrameB);

const astronautFrameA = renderRuntimePreview({ ...common, page:"animation", now:new Date(0) });
const astronautFrameB = renderRuntimePreview({ ...common, page:"animation", now:new Date(100) });
assert.notDeepEqual(astronautFrameA, astronautFrameB);

console.log("OLED runtime preview passed: six pages, performance data, Claude orbit and astronaut animation");
