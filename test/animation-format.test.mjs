import assert from "node:assert/strict";
import {
  animationCrc32,
  decodeVani,
  encodeVani,
  VANI_MAX_BYTES
} from "../src/animation-format.js";

const first = new Uint8Array(1024);
const second = Uint8Array.from(first);
const third = Uint8Array.from(first);
second[12] = 0xff;
third[12] = 0xff;
third[900] = 0x55;

const encoded = encodeVani([first, second, third], [100, 120, 80]);
assert.ok(encoded.length < 24 + 3 * (6 + 1024));
assert.ok(encoded.length < VANI_MAX_BYTES);

const decoded = decodeVani(encoded);
assert.deepEqual(decoded.pageFrames, [first, second, third]);
assert.deepEqual(decoded.delays, [100, 120, 80]);
assert.equal(decoded.crc, animationCrc32(encoded));

console.log("VANI format passed: raw frame, XOR-RLE delta, timing and CRC32");
