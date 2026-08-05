import assert from "node:assert/strict";
import {
  OLED_TWIN_FRAME_BYTES,
  OledTwinReceiver,
  TWIN_COMMAND,
  buildHidReport,
  calculateCrc32,
  parseHidReport
} from "../src/twin-protocol.js";
import { getBitmapPixel, ssd1306PageBufferToBitmap } from "../src/oled-bitmap.js";

function uint16(value) {
  return [value & 0xff, value >> 8];
}

function uint32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];
}

const source = Uint8Array.from(
  { length: OLED_TWIN_FRAME_BYTES },
  (_, index) => (index * 37 + 11) & 0xff
);
const sequence = 42;
const crc = calculateCrc32(source);
const receiver = new OledTwinReceiver();

receiver.accept(parseHidReport(buildHidReport(TWIN_COMMAND.FRAME_BEGIN, [
  ...uint16(sequence),
  ...uint16(source.length),
  ...uint32(crc),
  1
])));

for (let offset = 0; offset < source.length; offset += 56) {
  receiver.accept(parseHidReport(buildHidReport(TWIN_COMMAND.FRAME_CHUNK, [
    ...uint16(sequence),
    ...uint16(offset),
    ...source.slice(offset, offset + 56)
  ])));
}

const completed = receiver.accept(parseHidReport(buildHidReport(TWIN_COMMAND.FRAME_END, [
  ...uint16(sequence),
  ...uint32(crc)
])));
assert.ok(completed, "a complete frame should be published");
assert.equal(completed.sequence, sequence);
assert.equal(completed.crc32, crc);
assert.deepEqual(completed.bytes, source);

const damaged = buildHidReport(TWIN_COMMAND.HELLO, [1]);
damaged[10] ^= 0xff;
assert.equal(parseHidReport(damaged), null, "checksum corruption must be rejected");

const ssd1306 = new Uint8Array(OLED_TWIN_FRAME_BYTES);
ssd1306[5] = 0b00000100;
ssd1306[128 + 9] = 0b10000000;
const rowMajor = ssd1306PageBufferToBitmap(ssd1306);
assert.equal(getBitmapPixel(rowMajor, 5, 2), true);
assert.equal(getBitmapPixel(rowMajor, 9, 15), true);
assert.equal(getBitmapPixel(rowMajor, 5, 3), false);

console.log("OLED twin protocol passed: CRC32, frame assembly and SSD1306 conversion");
