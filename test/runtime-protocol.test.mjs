import assert from "node:assert/strict";
import {
  RUNTIME_PAGE,
  buildPersistentRuntimeBitmapPackets,
  buildVoiceSessionPacket,
  buildRgbSettingsPacket,
  buildRuntimeBitmapPackets,
  buildRuntimeClaudeTextPacket,
  buildRuntimeSettingsPacket,
  buildRuntimeStatusPacket,
  buildRuntimeStatusPackets,
  parseRuntimeSettingsPacket,
  validateRuntimePacket
} from "../src/runtime-protocol.js";

const status = buildRuntimeStatusPacket(
  { state:"tool", tool:"Read", text:"Reading source" },
  { cpu:42.4, gpu:73.6, memory:51.2, temperature:null, online:true },
  new Date(2026, 7, 6, 14, 26)
);
assert.equal(validateRuntimePacket(status), true);
assert.deepEqual(Array.from(status.slice(3, 15)), [3, 42, 74, 51, 255, 14, 26, 8, 6, 4, 1, 4]);
assert.equal(new TextDecoder().decode(status.slice(15, 19)), "Read");

const localizedStatus = buildRuntimeClaudeTextPacket(
  { state:"waiting", text:"需要用户确认", activeSessions:2, updatedAt:new Date(2026, 7, 6, 14, 25, 50).getTime() },
  new Date(2026, 7, 6, 14, 26)
);
assert.equal(localizedStatus[2], 6);
assert.equal(new TextDecoder().decode(localizedStatus.slice(4, 15)), "Needs input");
assert.equal(localizedStatus[25], 2);
assert.deepEqual(Array.from(localizedStatus.slice(26, 28)), [10, 0]);

const statusPackets = buildRuntimeStatusPackets(
  { state:"tool", tool:"Bash", text:"Running pio run" },
  { online:true },
  new Date(2026, 7, 6, 14, 26)
);
assert.equal(statusPackets.length, 2);
assert.deepEqual(statusPackets.map((packet) => packet[2]), [1, 6]);
assert.equal(new TextDecoder().decode(statusPackets[1].slice(4, 19)), "Running pio run");

const settings = buildRuntimeSettingsPacket({ page:"system", autoClaude:false });
assert.equal(validateRuntimePacket(settings), true);
assert.equal(settings[3], RUNTIME_PAGE.SYSTEM);
assert.equal(settings[4], 0);
assert.deepEqual(parseRuntimeSettingsPacket(settings), { page:"system", autoClaude:false });

const brandSettings = buildRuntimeSettingsPacket({ page:"brand", autoClaude:true });
assert.equal(brandSettings[3], RUNTIME_PAGE.BRAND);
assert.deepEqual(parseRuntimeSettingsPacket(brandSettings), { page:"brand", autoClaude:true });

const customSettings = buildRuntimeSettingsPacket({ page:"custom", autoClaude:false });
assert.equal(customSettings[3], RUNTIME_PAGE.CUSTOM);
assert.deepEqual(parseRuntimeSettingsPacket(customSettings), { page:"custom", autoClaude:false });

const rgbSettings = buildRgbSettingsPacket({ effect:6, brightness:72, speed:165, enabled:false, color:"#12A4F0" });
assert.equal(validateRuntimePacket(rgbSettings), true);
assert.deepEqual(Array.from(rgbSettings.slice(2, 10)), [7, 6, 72, 165, 0, 0x12, 0xA4, 0xF0]);

const rainbowBreathing = buildRgbSettingsPacket({ effect:7, brightness:80, speed:120, enabled:true, color:"#3366CC" });
assert.deepEqual(Array.from(rainbowBreathing.slice(2, 10)), [7, 7, 80, 120, 1, 0x33, 0x66, 0xCC]);

const clampedRgbSettings = buildRgbSettingsPacket({ effect:99, brightness:1, speed:999, enabled:true });
assert.deepEqual(Array.from(clampedRgbSettings.slice(2, 10)), [7, 7, 25, 200, 1, 0xD6, 0xFF, 0x38]);

const bitmap = Uint8Array.from({ length:1024 }, (_, index) => index & 0xff);
const bitmapPackets = buildRuntimeBitmapPackets(bitmap);
assert.equal(bitmapPackets.length, 42);
assert.ok(bitmapPackets.every(validateRuntimePacket));
assert.equal(bitmapPackets[0][2], 3);
assert.equal(bitmapPackets.at(-1)[2], 5);

const persistentBitmapPackets = buildPersistentRuntimeBitmapPackets(bitmap);
assert.equal(persistentBitmapPackets.length, 43);
assert.ok(persistentBitmapPackets.every(validateRuntimePacket));
assert.deepEqual(persistentBitmapPackets.slice(0, -1), bitmapPackets);
assert.equal(persistentBitmapPackets.at(-1)[2], 8);

const voiceSessionPacket = buildVoiceSessionPacket(true);
assert.equal(voiceSessionPacket[2], 9);
assert.equal(voiceSessionPacket[3], 1);
assert.ok(validateRuntimePacket(voiceSessionPacket));

console.log("Runtime protocol passed: OLED, RGB, metrics, clock and checksum");
