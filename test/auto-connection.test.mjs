import assert from "node:assert/strict";
import { AutoConnectionManager } from "../src/auto-connection.js";

const scheduled = [];
const states = [];
const calls = [];
const remembered = [];
let connected = false;
let usbResult = { state:"disconnected" };
let bleResult = { state:"disconnected" };

const manager = new AutoConnectionManager({
  restoreUsb:async () => {
    calls.push("usb");
    if (usbResult.state === "connected") connected = true;
    return usbResult;
  },
  restoreBle:async () => {
    calls.push("ble");
    if (bleResult.state === "connected") connected = true;
    return bleResult;
  },
  isConnected:() => connected,
  onState:(state) => states.push(state),
  onConnected:(transport) => remembered.push(transport),
  setTimer:(callback, delay) => {
    const timer = { callback, delay, cancelled:false };
    scheduled.push(timer);
    return timer;
  },
  clearTimer:(timer) => { timer.cancelled = true; },
  now:() => 1000
});

const latestTimer = () => [...scheduled].reverse().find((timer) => !timer.cancelled);
const runLatestTimer = async () => {
  const timer = latestTimer();
  assert.ok(timer, "应该存在等待执行的自动连接任务");
  timer.cancelled = true;
  await timer.callback();
};

manager.configure({ enabled:true, intervalSeconds:10, lastTransport:"ble" });
assert.equal(latestTimer().delay, 0, "开启自动连接后应该立即尝试一次");

bleResult = { state:"connected", name:"Vico Keyboard" };
await runLatestTimer();
assert.deepEqual(calls, ["usb", "ble"], "即使上次使用蓝牙，每轮也应该先尝试 USB，再尝试蓝牙");
assert.equal(states.at(-1).state, "connected");
assert.deepEqual(remembered, ["ble"], "连接成功后应该记住实际通道");

connected = false;
usbResult = { state:"disconnected" };
bleResult = { state:"disconnected" };
calls.length = 0;
manager.notifyDisconnected();
await runLatestTimer();
assert.deepEqual(calls, ["usb", "ble"], "后续每一轮仍应固定先尝试 USB，再尝试蓝牙");
assert.equal(latestTimer().delay, 10000, "失败后应该按用户设置的间隔重试");

manager.configure({ enabled:true, intervalSeconds:60, lastTransport:"usb" });
assert.equal(latestTimer().delay, 60000, "修改间隔后应该替换现有等待任务");

manager.configure({ enabled:true, intervalSeconds:1800, lastTransport:"usb" });
assert.equal(latestTimer().delay, 1800000, "自动连接间隔最大应该支持 30 分钟");

manager.pauseForManualDisconnect();
assert.equal(states.at(-1).state, "paused");
assert.equal(latestTimer(), undefined, "用户主动断开后不应继续自动重连");

assert.equal(manager.retryNow(), true);
assert.equal(latestTimer().delay, 0, "点击立即尝试应该解除暂停并马上重试");

manager.configure({ enabled:false, intervalSeconds:60, lastTransport:"usb" });
assert.equal(states.at(-1).state, "disabled");
assert.equal(latestTimer(), undefined, "关闭自动连接后应该清理定时器");

manager.stop();

// BLE 断线后的第一轮扫描尚未完成时，如果 USB 随后完成枚举，必须记住这次
// 热插拔事件，并在当前轮结束后立即重试，而不是等待完整的用户设置间隔。
const availabilityTimers = [];
let finishBleScan;
const availabilityManager = new AutoConnectionManager({
  restoreUsb:async () => ({ state:"disconnected" }),
  restoreBle:() => new Promise((resolve) => { finishBleScan = resolve; }),
  isConnected:() => false,
  setTimer:(callback, delay) => {
    const timer = { callback, delay, cancelled:false };
    availabilityTimers.push(timer);
    return timer;
  },
  clearTimer:(timer) => { timer.cancelled = true; }
});
availabilityManager.configure({ enabled:true, intervalSeconds:30, lastTransport:"ble" });
const initialAvailabilityTimer = availabilityTimers.at(-1);
initialAvailabilityTimer.cancelled = true;
const activeAttempt = initialAvailabilityTimer.callback();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(typeof finishBleScan, "function", "第一轮应已进入蓝牙扫描");
assert.equal(availabilityManager.notifyTransportAvailable(), true, "USB 枚举事件应被接受");
finishBleScan({ state:"disconnected" });
await activeAttempt;
const immediateAvailabilityTimer = [...availabilityTimers].reverse().find((timer) => !timer.cancelled);
assert.equal(immediateAvailabilityTimer?.delay, 0, "运行中发现 USB 后应立即开始下一轮连接");
availabilityManager.stop();

console.log("Auto connection passed: priority, interval, manual pause and retry");

