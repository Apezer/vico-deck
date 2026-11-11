import assert from "node:assert/strict";
import fs from "node:fs";
import {
  BLE_PROFILE_MAGIC,
  PROFILE_COMMAND,
  buildBleProfilePacket,
  compileMapping,
  compileProfile,
  compiledProfileCrc,
  profileCrc,
  parseBleProfilePacket,
  uint32ToBytes
} from "../src/profile-protocol.js";
import { shortcutDisplayLabel, shortcutFromKeyboardEvent } from "../src/key-shortcut.js";

assert.equal(PROFILE_COMMAND.ACTIVE_CHANGED, 0x91);
assert.deepEqual(
  Array.from(buildBleProfilePacket(PROFILE_COMMAND.SET_ACTIVE, [3])),
  [BLE_PROFILE_MAGIC, 1, PROFILE_COMMAND.SET_ACTIVE, 3]
);
assert.deepEqual(
  parseBleProfilePacket([BLE_PROFILE_MAGIC, 1, PROFILE_COMMAND.CRC, 2, 0x78, 0x56, 0x34, 0x12]),
  { command:PROFILE_COMMAND.CRC, payload:Uint8Array.from([2, 0x78, 0x56, 0x34, 0x12]) }
);
assert.equal(parseBleProfilePacket([0x56, 1, 2]), null);
assert.throws(
  () => parseBleProfilePacket([BLE_PROFILE_MAGIC, 2, PROFILE_COMMAND.HELLO]),
  /不支持的蓝牙预设协议版本/
);

const profiles = JSON.parse(fs.readFileSync(new URL("../shared/default-profiles.json", import.meta.url), "utf8"));
assert.equal(profiles.length, 5);

for (const [slot, profile] of profiles.entries()) {
  assert.equal(profile.slot, slot);
  assert.equal(compileProfile(profile).length, 8);
  assert.equal(profileCrc(profile), compiledProfileCrc(compileProfile(profile)));
}

assert.deepEqual(
  compileProfile(profiles[0]).map((item) => Array.from(item.bytes)),
  [
    [1, 0, 0xd8, 0, 0],
    [1, 0, 0xd9, 0, 0],
    [1, 0, 0xd7, 0, 0],
    [1, 0, 0xb0, 0, 0],
    [1, 0, 0xb2, 0, 0],
    [1, 0, 0xda, 0, 0],
    [1, 0x09, 0, 0, 0],
    [3, 0, 0, 0, 0]
  ]
);
assert.equal(profileCrc(profiles[0]), 0x1d05969a);
assert.deepEqual(uint32ToBytes(0x1d05969a), [0x9a, 0x96, 0x05, 0x1d]);
assert.deepEqual(compileMapping({ type:"shortcut", value:"Ctrl+Shift+Esc" }), {
  action:1, modifiers:3, keycode:0xb1, consumer:0
});
assert.throws(() => compileMapping({ type:"shortcut", value:"Ctrl+UnsupportedKey" }), /不支持的按键/);
assert.deepEqual(compileMapping({ type:"shortcut", value:"Ctrl+Alt+Shift+F12" }), {
  action:1, modifiers:7, keycode:0xcd, consumer:0
});
assert.deepEqual(compileMapping({ type:"shortcut", value:"Win+PLUS" }), {
  action:1, modifiers:8, keycode:0x2b, consumer:0
});
assert.deepEqual(compileMapping({ type:"keyboard", value:"NUMPAD_7" }), {
  action:1, modifiers:0, keycode:0xe7, consumer:0
});
assert.deepEqual(compileMapping({ type:"media", value:"CALCULATOR" }), {
  action:2, modifiers:0, keycode:0, consumer:10
});
assert.deepEqual(compileMapping({ type:"system", value:"TASK_MANAGER" }), {
  action:1, modifiers:3, keycode:0xb1, consumer:0
});

assert.equal(shortcutFromKeyboardEvent({ code:"KeyP", ctrlKey:true, shiftKey:true }), "Ctrl+Shift+P");
assert.equal(shortcutFromKeyboardEvent({ code:"Equal", ctrlKey:true, shiftKey:true }), "Ctrl+Shift+EQUAL");
assert.equal(shortcutFromKeyboardEvent({ code:"Numpad7", altKey:true }), "Alt+NUMPAD_7");
assert.equal(shortcutFromKeyboardEvent({ code:"ControlLeft", ctrlKey:true }), null);
assert.equal(shortcutDisplayLabel("Ctrl+Shift+P"), "Ctrl + Shift + P");

console.log("Five-profile protocol passed: defaults, bindings and CRC32");
