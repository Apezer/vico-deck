import assert from "node:assert/strict";
import { gifCanvasBackground } from "../src/gif-converter.js";

// 未反相时，画布颜色与用户选择一致。
assert.equal(gifCanvasBackground("black", false), "#000000");
assert.equal(gifCanvasBackground("white", false), "#ffffff");

// 反相发生在后续阶段，因此画布先使用相反颜色，最终结果仍保持用户选择。
assert.equal(gifCanvasBackground("black", true), "#ffffff");
assert.equal(gifCanvasBackground("white", true), "#000000");

// 未知值安全回退为黑色背景。
assert.equal(gifCanvasBackground("unknown", false), "#000000");

console.log("gif-converter tests passed");
