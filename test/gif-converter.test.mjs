import assert from "node:assert/strict";
import { gifCanvasBackground, gifTargetRect } from "../src/gif-converter.js";

// 未反相时，画布颜色与用户选择一致。
assert.equal(gifCanvasBackground("black", false), "#000000");
assert.equal(gifCanvasBackground("white", false), "#ffffff");

// 反相发生在后续阶段，因此画布先使用相反颜色，最终结果仍保持用户选择。
assert.equal(gifCanvasBackground("black", true), "#ffffff");
assert.equal(gifCanvasBackground("white", true), "#000000");

// 未知值安全回退为黑色背景。
assert.equal(gifCanvasBackground("unknown", false), "#000000");

// 方形 GIF 可以在完整、均衡、裁剪和拉伸四种策略之间选择。
assert.deepEqual(gifTargetRect(100, 100, "contain"), { x:32, y:0, width:64, height:64 });
assert.deepEqual(gifTargetRect(100, 100, "balanced", 140), { x:19, y:-13, width:90, height:90 });
assert.deepEqual(gifTargetRect(100, 100, "cover"), { x:0, y:-32, width:128, height:128 });
assert.deepEqual(gifTargetRect(100, 100, "stretch"), { x:0, y:0, width:128, height:64 });

console.log("gif-converter tests passed");
