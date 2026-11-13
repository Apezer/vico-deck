import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  bitmapFromBase64,
  bitmapToBase64,
  getBitmapPixel,
  renderOledTemplate
} from "../src/oled-bitmap.js";
import { drawPixelFrame } from "../src/oled-canvas-renderer.js";

const frame = renderOledTemplate({ mode: "minimal" });
assert.equal(frame.length, 1024);

// 根据固件的 Adafruit GFX 经典字体和精确布局生成：
// renderKeyStatus() + drawKeyBox()，所有按键释放，USB 模式。
const digest = createHash("sha256").update(frame).digest("hex");
assert.equal(
  digest,
  "a83dfd38fec5458196c7200e12952a61a1fd43f130b54645e4d1789df3b449d0"
);

assert.equal(getBitmapPixel(frame, 0, 12), true, "header separator");
assert.equal(getBitmapPixel(frame, 127, 12), true, "full-width separator");
assert.equal(getBitmapPixel(frame, 4, 18), true, "first key top-left");
assert.equal(getBitmapPixel(frame, 31, 31), true, "first key bottom-right");
assert.equal(getBitmapPixel(frame, 121, 47), true, "last key bottom-right");

const restored = bitmapFromBase64(bitmapToBase64(frame));
assert.deepEqual(restored, frame);

assert.equal(
  drawPixelFrame({ getContext:() => null }, frame),
  false,
  "Canvas 2D context 不可用时应安全返回，而不是让 React 页面崩溃"
);
const context = { clearRect() {}, fillRect() {}, fillStyle:"" };
assert.equal(
  drawPixelFrame({ width:512, height:256, getContext:() => context }, frame, undefined),
  true,
  "有效 Canvas 应完成绘制，并兼容缺失的亮度配置"
);

console.log("OLED firmware frame match passed: 1024 bytes");
