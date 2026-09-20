import assert from "node:assert/strict";
import fs from "node:fs";
import { VicoBleDevice } from "../src/device.js";

const calls = [];
let receiveBridgeEvent = () => {};
let connected = false;

globalThis.window = {
  vico:{
    ble:{
      onEvent(callback) {
        receiveBridgeEvent = callback;
        return () => { receiveBridgeEvent = () => {}; };
      },
      async command(type, payload = {}) {
        calls.push({ type, payload });
        if (type === "restore") return { state:"disconnected" };
        if (type === "connect") {
          connected = true;
          return { state:"connected", name:"Vico Keyboard", batteryPercent:67 };
        }
        if (type === "disconnect") {
          connected = false;
          return true;
        }
        if (type === "write") return connected;
        throw new Error("unexpected command");
      }
    }
  }
};

const statuses = [];
const connection = new VicoBleDevice((status) => statuses.push(status));

await connection.restore();
assert.equal(statuses.length, 0, "没有已连接设备时不应伪造连接状态");

await connection.request();
assert.equal(statuses.at(-1).state, "connected");
assert.equal(statuses.at(-1).batteryPercent, 67);
assert.deepEqual(calls.slice(0, 2).map((call) => call.type), ["restore", "connect"]);
assert.equal(calls[2].type, "write", "建立通知监听后应发送语音会话握手");

connection.disconnect();
await connection.disconnectPromise;
assert.equal(statuses.at(-1).state, "disconnected");
assert.deepEqual(calls.slice(-2).map((call) => call.type), ["write", "disconnect"]);

await connection.request();
receiveBridgeEvent({ type:"unexpected-disconnect" });
assert.equal(statuses.at(-1).state, "disconnected", "物理断线事件应立即清空页面会话");

await connection.request();
assert.equal(statuses.at(-1).state, "connected", "隐藏窗口重建后页面门面应能再次连接");

const bridgeSource = fs.readFileSync(new URL("../electron/ble-bridge.js", import.meta.url), "utf8");
const mainSource = fs.readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
assert.match(bridgeSource, /\^vico keyboard\$\/i/, "蓝牙后台必须只接受精确的设备名称");
assert.match(mainSource, /setImmediate\(destroyBleBridgeWindow\)/, "物理断线后必须销毁独立蓝牙窗口");

console.log("BLE reconnect passed: isolated bridge, manual pause and physical-disconnect rebuild");
