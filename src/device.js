// Vico WebHID protocol draft (64-byte reports)
// 0x01 HELLO, 0x10 SET_KEY, 0x20 SET_OLED, 0x30 COMMIT
const REPORT_ID = 0;
const COMMAND = { HELLO: 0x01, SET_KEY: 0x10, SET_OLED: 0x20, COMMIT: 0x30 };

function packet(command, payload = []) {
  const bytes = new Uint8Array(64);
  bytes[0] = command;
  bytes[1] = Math.min(payload.length, 61);
  bytes.set(payload.slice(0, 61), 2);
  let checksum = 0;
  for (let i = 0; i < 63; i += 1) checksum ^= bytes[i];
  bytes[63] = checksum;
  return bytes;
}

function encodeJson(value) {
  return Array.from(new TextEncoder().encode(JSON.stringify(value)));
}

export class VicoDevice {
  constructor(onStatus) {
    this.device = null;
    this.onStatus = onStatus;
    this.handleDisconnect = this.handleDisconnect.bind(this);
    navigator.hid?.addEventListener("disconnect", this.handleDisconnect);
  }

  async restore() {
    if (!navigator.hid) return this.onStatus({ state: "unsupported" });
    const devices = await navigator.hid.getDevices();
    const found = devices.find((d) => /vico/i.test(d.productName || ""));
    if (found) await this.open(found);
  }

  async request() {
    if (!navigator.hid) throw new Error("当前环境不支持 WebHID");
    const [device] = await navigator.hid.requestDevice({ filters: [] });
    if (device) await this.open(device);
    return device;
  }

  async open(device) {
    if (!device.opened) await device.open();
    this.device = device;
    this.onStatus({
      state: "connected",
      name: device.productName || "Vico Keyboard",
      vendorId: device.vendorId,
      productId: device.productId
    });
  }

  handleDisconnect(event) {
    if (event.device === this.device) {
      this.device = null;
      this.onStatus({ state: "disconnected" });
    }
  }

  async send(command, payload) {
    if (!this.device?.opened) throw new Error("请先连接键盘");
    await this.device.sendReport(REPORT_ID, packet(command, payload));
  }

  async sync(profile) {
    for (const mapping of profile.mappings) {
      await this.send(COMMAND.SET_KEY, [mapping.key, ...encodeJson(mapping)]);
    }
    await this.send(COMMAND.SET_OLED, encodeJson(profile.oled));
    await this.send(COMMAND.COMMIT, []);
  }
}

const BLE_SERVICE_UUID = "7b6a0001-7c6e-4b3d-9f5f-7669636f0001";
const BLE_RX_UUID = "7b6a0002-7c6e-4b3d-9f5f-7669636f0002";
const BLE_TX_UUID = "7b6a0003-7c6e-4b3d-9f5f-7669636f0003";

export class VicoBleDevice {
  constructor(onStatus, onAck) {
    this.device = null;
    this.rx = null;
    this.tx = null;
    this.onStatus = onStatus;
    this.onAck = onAck;
    this.disconnectHandler = () => {
      this.rx = null;
      this.tx = null;
      this.onStatus({ state: "disconnected" });
    };
  }

  async restore() {
    if (!navigator.bluetooth?.getDevices) return;
    const devices = await navigator.bluetooth.getDevices();
    const found = devices.find((device) => /vico keyboard/i.test(device.name || ""));
    if (found) await this.open(found);
  }

  async request() {
    if (!navigator.bluetooth) throw new Error("当前环境不支持蓝牙 GATT");
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "Vico Keyboard" }],
      optionalServices: [BLE_SERVICE_UUID]
    });
    await this.open(device);
    return device;
  }

  async open(device) {
    this.device?.removeEventListener("gattserverdisconnected", this.disconnectHandler);
    this.device = device;
    this.device.addEventListener("gattserverdisconnected", this.disconnectHandler);

    this.onStatus({ state: "connecting", name: device.name || "Vico Keyboard" });
    const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE_UUID);
    this.rx = await service.getCharacteristic(BLE_RX_UUID);
    this.tx = await service.getCharacteristic(BLE_TX_UUID);

    if (this.tx.properties.notify) {
      await this.tx.startNotifications();
      this.tx.addEventListener("characteristicvaluechanged", (event) => {
        const value = new Uint8Array(event.target.value.buffer);
        const text = new TextDecoder().decode(value);
        this.onAck?.(text);
      });
    }

    this.onStatus({ state: "connected", name: device.name || "Vico Keyboard ESP32-S3" });
  }

  async writeClaudeStatus(status) {
    if (!this.rx || !this.device?.gatt?.connected) throw new Error("请先连接 Vico 蓝牙键盘");
    const payload = {
      state: String(status.state || "working").slice(0, 8),
      tool: String(status.tool || "").replace(/[^\x20-\x7e]/g, "").slice(0, 14),
      text: String(status.text || "Claude Code is working").replace(/[^\x20-\x7e]/g, "").slice(0, 42)
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    if (this.rx.properties.write) await this.rx.writeValueWithResponse(bytes);
    else await this.rx.writeValueWithoutResponse(bytes);
  }

  disconnect() {
    this.device?.gatt?.disconnect();
  }
}
