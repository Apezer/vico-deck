import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  bitmapFromBase64,
  bitmapToBase64,
  getBitmapPixel,
  renderOledTemplate
} from "../src/oled-bitmap.js";

const frame = renderOledTemplate({ mode: "minimal" });
assert.equal(frame.length, 1024);

// Generated from the firmware's Adafruit GFX classic font and exact layout:
// renderKeyStatus() + drawKeyBox(), all keys released, USB mode.
const digest = createHash("sha256").update(frame).digest("hex");
assert.equal(
  digest,
  "3c7275ba96761f014c264711cbe5f27a3c0202b657815d518bea57baeeda5fe1"
);

assert.equal(getBitmapPixel(frame, 0, 12), true, "header separator");
assert.equal(getBitmapPixel(frame, 127, 12), true, "full-width separator");
assert.equal(getBitmapPixel(frame, 4, 18), true, "first key top-left");
assert.equal(getBitmapPixel(frame, 31, 31), true, "first key bottom-right");
assert.equal(getBitmapPixel(frame, 121, 47), true, "last key bottom-right");

const restored = bitmapFromBase64(bitmapToBase64(frame));
assert.deepEqual(restored, frame);

console.log("OLED firmware frame match passed: 1024 bytes");
