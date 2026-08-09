import assert from "node:assert/strict";
import { VicoBleDevice } from "../src/device.js";

class FakeCharacteristic {
  constructor({ battery = false } = {}) {
    this.battery = battery;
    this.properties = { notify:true, write:true };
    this.listeners = new Map();
  }

  async readValue() {
    return new DataView(Uint8Array.of(this.battery ? 67 : 0).buffer);
  }

  async startNotifications() { return this; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name, listener) {
    if (this.listeners.get(name) === listener) this.listeners.delete(name);
  }
}

const rx = new FakeCharacteristic();
const tx = new FakeCharacteristic();
const battery = new FakeCharacteristic({ battery:true });
const customService = {
  getCharacteristic:async (uuid) => uuid.includes("0002-") ? rx : tx
};
const batteryService = { getCharacteristic:async () => battery };
const gatt = {
  connected:false,
  connectCount:0,
  serviceDiscoveryCount:0,
  failNextServiceDiscovery:false,
  async connect() { this.connected = true; this.connectCount += 1; return this; },
  disconnect() {
    this.connected = false;
    listeners.get("gattserverdisconnected")?.();
  },
  async getPrimaryService(uuid) {
    if (!uuid.includes("180f")) {
      this.serviceDiscoveryCount += 1;
      if (this.failNextServiceDiscovery) {
        this.failNextServiceDiscovery = false;
        throw new DOMException("GATT cache is stale", "NetworkError");
      }
    }
    return uuid.includes("180f") ? batteryService : customService;
  }
};
const listeners = new Map();
const device = {
  name:"Vico Keyboard",
  gatt,
  addEventListener(name, listener) { listeners.set(name, listener); },
  removeEventListener(name, listener) {
    if (listeners.get(name) === listener) listeners.delete(name);
  }
};

let chooserCalls = 0;
Object.defineProperty(globalThis, "navigator", {
  configurable:true,
  value:{ bluetooth:{
    getDevices:async () => [device],
    requestDevice:async () => { chooserCalls += 1; throw new Error("不应重新扫描已授权设备"); }
  } }
});

const statuses = [];
const connection = new VicoBleDevice((status) => statuses.push(status));
await connection.request();
assert.equal(gatt.connectCount, 1);
assert.equal(statuses.at(-1).state, "connected");
assert.equal(statuses.at(-1).batteryPercent, 67);

connection.disconnect();
await connection.request();
assert.equal(gatt.connectCount, 1, "软件会话重连应复用Windows HID正在共用的物理GATT连接");
assert.equal(gatt.serviceDiscoveryCount, 1, "软件会话重连应复用已经验证过的Vico服务句柄");
assert.equal(chooserCalls, 0, "已授权设备重连不应依赖BLE广播扫描");

console.log("BLE reconnect passed: app-session resume without breaking the shared HID link");
