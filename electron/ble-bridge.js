const SERVICE_UUID = "7b6a0001-7c6e-4b3d-9f5f-7669636f0001";
const RX_UUID = "7b6a0002-7c6e-4b3d-9f5f-7669636f0002";
const TX_UUID = "7b6a0003-7c6e-4b3d-9f5f-7669636f0003";
const BATTERY_SERVICE_UUID = "0000180f-0000-1000-8000-00805f9b34fb";
const BATTERY_LEVEL_UUID = "00002a19-0000-1000-8000-00805f9b34fb";
const CONNECT_TIMEOUT_MS = 10000;
const SERVICE_DISCOVERY_ATTEMPTS = 3;

let device = null;
let rx = null;
let tx = null;
let battery = null;
let connectedStatus = null;
let sessionActive = false;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const isVicoKeyboard = (candidate) => /^vico keyboard$/i.test(candidate?.name || "");
const emit = (event) => window.vicoBleHost.emit(event);

function withTimeout(operation, message, timeout = CONNECT_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    Promise.resolve(operation),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })
  ]).finally(() => clearTimeout(timer));
}

function removeCharacteristicListeners() {
  tx?.removeEventListener("characteristicvaluechanged", handleData);
  battery?.removeEventListener("characteristicvaluechanged", handleBattery);
}

function clearConnectionState() {
  removeCharacteristicListeners();
  rx = null;
  tx = null;
  battery = null;
  connectedStatus = null;
  sessionActive = false;
}

function handleData(event) {
  const view = event.target.value;
  emit({ type:"data", bytes:Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) });
}

function handleBattery(event) {
  const batteryPercent = event.target.value.getUint8(0);
  connectedStatus = { ...connectedStatus, batteryPercent };
  emit({ type:"battery", batteryPercent });
}

function handleUnexpectedDisconnect() {
  device?.removeEventListener("gattserverdisconnected", handleUnexpectedDisconnect);
  clearConnectionState();
  device = null;
  // 主进程随后销毁隐藏窗口，释放 Chromium 中已经失效的全部 GATT 对象。
  emit({ type:"unexpected-disconnect" });
}

async function connectAndDiscover(candidate) {
  let lastError;
  for (let attempt = 0; attempt < SERVICE_DISCOVERY_ATTEMPTS; attempt += 1) {
    try {
      const server = candidate.gatt.connected
        ? candidate.gatt
        : await withTimeout(candidate.gatt.connect(), "蓝牙连接超时，请唤醒键盘后重试");
      const service = await withTimeout(server.getPrimaryService(SERVICE_UUID), "Vico 状态服务发现超时");
      return { server, service };
    } catch (error) {
      lastError = error;
      candidate.removeEventListener("gattserverdisconnected", handleUnexpectedDisconnect);
      if (candidate.gatt.connected) candidate.gatt.disconnect();
      if (attempt + 1 < SERVICE_DISCOVERY_ATTEMPTS) {
        await wait(500 * (attempt + 1));
        candidate.addEventListener("gattserverdisconnected", handleUnexpectedDisconnect);
      }
    }
  }
  throw new Error("没有发现 Vico 状态服务。请唤醒键盘并重新连接。", { cause:lastError });
}

async function writePackets(packets) {
  if (!sessionActive || !rx || !device?.gatt?.connected) return false;
  for (const bytes of packets) {
    const packet = Uint8Array.from(bytes || []);
    if (rx.properties.write && rx.writeValueWithResponse) await rx.writeValueWithResponse(packet);
    else if (rx.writeValueWithoutResponse) await rx.writeValueWithoutResponse(packet);
    else throw new Error("键盘的蓝牙写入特征不可用");
  }
  return true;
}

async function open(candidate) {
  if (!isVicoKeyboard(candidate)) throw new Error("所选设备不是 Vico Keyboard");

  // 软件内的“断开”仅暂停会话；物理 GATT 未断开时可快速恢复。
  if (device === candidate && candidate.gatt.connected && rx && tx) {
    tx.removeEventListener("characteristicvaluechanged", handleData);
    tx.addEventListener("characteristicvaluechanged", handleData);
    if (battery) {
      battery.removeEventListener("characteristicvaluechanged", handleBattery);
      battery.addEventListener("characteristicvaluechanged", handleBattery);
    }
    sessionActive = true;
    emit({ type:"connected", status:connectedStatus });
    return connectedStatus;
  }

  device?.removeEventListener("gattserverdisconnected", handleUnexpectedDisconnect);
  clearConnectionState();
  device = candidate;
  device.addEventListener("gattserverdisconnected", handleUnexpectedDisconnect);
  emit({ type:"connecting", name:candidate.name || "Vico Keyboard" });

  try {
    const { server, service } = await connectAndDiscover(candidate);
    rx = await withTimeout(service.getCharacteristic(RX_UUID), "读取蓝牙发送通道超时");
    tx = await withTimeout(service.getCharacteristic(TX_UUID), "读取蓝牙通知通道超时");

    let batteryPercent = null;
    try {
      const batteryService = await withTimeout(server.getPrimaryService(BATTERY_SERVICE_UUID), "读取电池服务超时", 4000);
      battery = await withTimeout(batteryService.getCharacteristic(BATTERY_LEVEL_UUID), "读取电池特征超时", 4000);
      const initial = await withTimeout(battery.readValue(), "读取电量超时", 4000);
      batteryPercent = initial.getUint8(0);
      if (battery.properties.notify) {
        await withTimeout(battery.startNotifications(), "订阅电量通知超时", 4000);
        battery.addEventListener("characteristicvaluechanged", handleBattery);
      }
    } catch {
      battery = null;
    }

    if (tx.properties.notify) {
      await withTimeout(tx.startNotifications(), "订阅 Vico 状态通知超时");
      tx.addEventListener("characteristicvaluechanged", handleData);
    }
    connectedStatus = { state:"connected", name:candidate.name || "Vico Keyboard", batteryPercent };
    sessionActive = true;
    emit({ type:"connected", status:connectedStatus });
    return connectedStatus;
  } catch (error) {
    candidate.removeEventListener("gattserverdisconnected", handleUnexpectedDisconnect);
    if (candidate.gatt.connected) candidate.gatt.disconnect();
    clearConnectionState();
    device = null;
    emit({ type:"disconnected" });
    throw error;
  }
}

async function authorizedDevices() {
  if (!navigator.bluetooth?.getDevices) return [];
  return (await navigator.bluetooth.getDevices()).filter(isVicoKeyboard);
}

async function restore() {
  if (!navigator.bluetooth) return { state:"unsupported" };
  for (const candidate of await authorizedDevices()) {
    try { return await open(candidate); } catch { /* 继续尝试其他精确匹配的授权设备。 */ }
  }
  return { state:"disconnected" };
}

async function connect() {
  if (!navigator.bluetooth) throw new Error("当前环境不支持蓝牙 GATT");
  for (const candidate of await authorizedDevices()) {
    try { return await open(candidate); } catch { /* 授权对象失效时回退到选择器。 */ }
  }
  const selected = await navigator.bluetooth.requestDevice({
    filters:[{ name:"Vico Keyboard" }],
    optionalServices:[SERVICE_UUID, BATTERY_SERVICE_UUID]
  });
  return open(selected);
}

async function disconnect() {
  sessionActive = false;
  removeCharacteristicListeners();
  emit({ type:"disconnected", manual:true });
  return true;
}

async function execute(request = {}) {
  switch (request.type) {
    case "restore": return restore();
    case "connect": return connect();
    case "disconnect": return disconnect();
    case "write": return writePackets(request.packets || []);
    default: throw new Error("未知的蓝牙桥接命令");
  }
}

// 主进程通过带用户手势标记的 executeJavaScript 调用该入口。
window.vicoBleBridge = { execute };
