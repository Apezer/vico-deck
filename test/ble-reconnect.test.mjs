import assert from "node:assert/strict";
import fs from "node:fs";
import { VicoBleDevice } from "../src/device.js";
import { BLE_PROFILE_MAGIC, PROFILE_COMMAND } from "../src/profile-protocol.js";

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
        if (type === "auto-connect") {
          connected = true;
          return { state:"connected", name:"Vico Keyboard", batteryPercent:67 };
        }
        if (type === "connect") {
          connected = true;
          return { state:"connected", name:"Vico Keyboard", batteryPercent:67 };
        }
        if (type === "disconnect") {
          connected = false;
          return true;
        }
        if (type === "write") {
          const packet = payload.packets?.[0] || [];
          if (packet[0] === BLE_PROFILE_MAGIC) {
            const command = packet[2];
            let response;
            if (command === PROFILE_COMMAND.HELLO) {
              response = [BLE_PROFILE_MAGIC, 1, PROFILE_COMMAND.HELLO_ACK, 1, 5, 0];
            } else if (command === PROFILE_COMMAND.GET_CRC) {
              response = [BLE_PROFILE_MAGIC, 1, PROFILE_COMMAND.CRC, packet[3], 0, 0, 0, 0];
            } else {
              const slot = command === PROFILE_COMMAND.BEGIN ? packet[4] : packet[3];
              response = [BLE_PROFILE_MAGIC, 1, PROFILE_COMMAND.ACK, command, 0, slot, slot];
            }
            queueMicrotask(() => receiveBridgeEvent({ type:"data", bytes:response }));
          }
          return connected;
        }
        throw new Error("unexpected command");
      }
    }
  }
};

const statuses = [];
const connection = new VicoBleDevice((status) => statuses.push(status));

await connection.restore();
assert.equal(statuses.length, 0, "没有已连接设备时不应伪造连接状态");

await connection.autoConnect();
assert.equal(statuses.at(-1).state, "connected", "自动扫描发现设备后应该建立蓝牙 GATT 会话");
assert.equal(statuses.at(-1).protocolVersion, 1, "连接后应读取蓝牙预设协议能力");
assert.deepEqual(statuses.at(-1).profileCrcs, [0, 0, 0, 0, 0]);
connection.disconnect();
await connection.disconnectPromise;

await connection.request();
assert.equal(statuses.at(-1).state, "connected");
assert.equal(statuses.at(-1).batteryPercent, 67);
assert.deepEqual(calls.slice(0, 3).map((call) => call.type), ["restore", "auto-connect", "write"]);
assert.ok(calls.some((call) => call.type === "connect"), "手动连接仍应保留原有入口");

connection.disconnect();
await connection.disconnectPromise;
assert.equal(statuses.at(-1).state, "disconnected");
assert.deepEqual(calls.slice(-2).map((call) => call.type), ["write", "disconnect"]);

await connection.request();
receiveBridgeEvent({ type:"unexpected-disconnect" });
assert.equal(statuses.at(-1).state, "disconnected", "物理断线事件应立即清空页面会话");

await connection.request();
assert.equal(statuses.at(-1).state, "connected", "隐藏窗口重建后页面门面应能再次连接");

const profiles = JSON.parse(fs.readFileSync(new URL("../shared/default-profiles.json", import.meta.url), "utf8"));
await connection.sync(profiles[0]);
assert.equal(statuses.at(-1).activeProfile, 0, "蓝牙提交完成后应更新活动预设");
assert.notEqual(statuses.at(-1).profileCrcs[0], 0, "蓝牙提交完成后应缓存设备预设 CRC");
assert.equal(
  calls.filter((call) => call.type === "write" && call.payload.packets?.[0]?.[2] === PROFILE_COMMAND.SET_KEY).length,
  8,
  "一套预设必须逐键发送八个绑定"
);

const bridgeSource = fs.readFileSync(new URL("../electron/ble-bridge.js", import.meta.url), "utf8");
const mainSource = fs.readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
assert.match(bridgeSource, /\^vico keyboard\$\/i/, "蓝牙后台必须只接受精确的设备名称");
assert.match(mainSource, /handleAutomaticBluetoothSelection/, "自动连接必须由主进程静默筛选 Vico Keyboard");
assert.match(mainSource, /setImmediate\(destroyBleBridgeWindow\)/, "物理断线后必须销毁独立蓝牙窗口");

console.log("BLE reconnect passed: isolated bridge, manual pause and physical-disconnect rebuild");
