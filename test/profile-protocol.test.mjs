import assert from "node:assert/strict";
import fs from "node:fs";
import {
  PROFILE_COMMAND,
  compileMapping,
  compileProfile,
  compiledProfileCrc,
  profileCrc,
  uint32ToBytes
} from "../src/profile-protocol.js";

assert.equal(PROFILE_COMMAND.ACTIVE_CHANGED, 0x91);

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

console.log("Five-profile protocol passed: defaults, bindings and CRC32");
