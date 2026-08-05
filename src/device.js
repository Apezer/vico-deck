import { OLED_BITMAP_BYTES, renderOledTemplate } from "./oled-bitmap.js";
import {
  OledTwinReceiver,
  TWIN_COMMAND,
  VICO_HID_REPORT_ID,
  buildHidReport,
  parseHidReport
} from "./twin-protocol.js";

const VICO_USB_VENDOR_ID = 0x3343;
const VICO_USB_PRODUCT_ID = 0x83cf;
const VICO_VENDOR_USAGE_PAGE = 0xff00;
const VICO_VENDOR_USAGE = 0x01;
const COMMAND = {
  ...TWIN_COMMAND,
  SET_KEY: 0x10,
  OLED_META: 0x20,
  OLED_BITMAP: 0x21,
  COMMIT: 0x30
};
const OLED_CHUNK_BYTES = 58;

function isVicoUsbDevice(device) {
  return device?.vendorId === VICO_USB_VENDOR_ID
    && device?.productId === VICO_USB_PRODUCT_ID
    && /^vico keyboard$/i.test(device?.productName || "")
    && device.collections?.some(
      (collection) => collection.usagePage === VICO_VENDOR_USAGE_PAGE
        && collection.usage === VICO_VENDOR_USAGE
    );
}

function encodeJson(value) {
  return Array.from(new TextEncoder().encode(JSON.stringify(value)));
}

export class VicoDevice {
  constructor(onStatus, onFrame = () => {}) {
    this.device = null;
    this.onStatus = onStatus;
    this.onFrame = onFrame;
    this.twinReceiver = new OledTwinReceiver();
    this.helloResolver = null;
    this.helloRejecter = null;
    this.helloTimer = null;
    this.handleDisconnect = this.handleDisconnect.bind(this);
    this.handleInputReport = this.handleInputReport.bind(this);
    navigator.hid?.addEventListener("disconnect", this.handleDisconnect);
  }

  async restore() {
    if (!navigator.hid) return this.onStatus({ state: "unsupported" });
    const devices = await navigator.hid.getDevices();
    const found = devices.find(isVicoUsbDevice);
    if (found) await this.open(found);
  }

  async request() {
    if (!navigator.hid) throw new Error("当前环境不支持 WebHID");
    const grantedDevices = (await navigator.hid.getDevices()).filter(isVicoUsbDevice);
    if (grantedDevices.length === 1) {
      await this.open(grantedDevices[0]);
      return grantedDevices[0];
    }
    const [device] = await navigator.hid.requestDevice({
      filters: [{
        vendorId: VICO_USB_VENDOR_ID,
        productId: VICO_USB_PRODUCT_ID,
        usagePage: VICO_VENDOR_USAGE_PAGE,
        usage: VICO_VENDOR_USAGE
      }]
    });
    if (device) await this.open(device);
    return device;
  }

  async open(device) {
    if (!isVicoUsbDevice(device)) {
      if (device?.opened) await device.close();
      throw new Error("所选设备不是 Vico Keyboard，连接已取消");
    }

    this.onStatus({ state: "connecting", name: device.productName || "Vico Keyboard" });
    try {
      if (!device.opened) await device.open();
      this.device?.removeEventListener("inputreport", this.handleInputReport);
      this.device = device;
      this.device.addEventListener("inputreport", this.handleInputReport);
      this.twinReceiver.reset();

      const info = await this.performHandshake();
      await this.send(COMMAND.DISPLAY_SUBSCRIBE, [1]);

      this.onStatus({
        state: "connected",
        name: device.productName || "Vico Keyboard",
        vendorId: device.vendorId,
        productId: device.productId,
        firmwareVersion: info.firmwareVersion,
        protocolVersion: info.protocolVersion
      });
    } catch (error) {
      device.removeEventListener("inputreport", this.handleInputReport);
      if (device.opened) await device.close().catch(() => {});
      this.device = null;
      this.clearHandshake();
      this.onStatus({ state: "disconnected" });
      throw error;
    }
  }

  async performHandshake() {
    this.clearHandshake();
    const response = new Promise((resolve, reject) => {
      this.helloResolver = resolve;
      this.helloRejecter = reject;
      this.helloTimer = setTimeout(
        () => reject(new Error("Vico 固件未响应身份握手，请烧录支持数字孪生的新固件")),
        1800
      );
    });
    await this.send(COMMAND.HELLO, [1]);
    return response.finally(() => this.clearHandshake());
  }

  clearHandshake() {
    clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this.helloResolver = null;
    this.helloRejecter = null;
  }

  handleInputReport(event) {
    if (event.device !== this.device || event.reportId !== VICO_HID_REPORT_ID) return;
    const parsed = parseHidReport(event.data);
    if (!parsed) return;

    if (parsed.command === COMMAND.HELLO_ACK) {
      const payload = parsed.payload;
      const signature = new TextDecoder().decode(payload.slice(7, 11));
      if (payload.length >= 11 && signature === "VICO") {
        this.helloResolver?.({
          protocolVersion: payload[0],
          width: payload[1],
          height: payload[2],
          format: payload[3],
          firmwareVersion: `${payload[4]}.${payload[5]}.${payload[6]}`
        });
      } else {
        this.helloRejecter?.(new Error("设备身份握手无效，连接已取消"));
      }
      return;
    }

    const frame = this.twinReceiver.accept(parsed);
    if (frame) this.onFrame(frame);
  }

  handleDisconnect(event) {
    if (event.device === this.device) {
      this.device.removeEventListener("inputreport", this.handleInputReport);
      this.device = null;
      this.twinReceiver.reset();
      this.clearHandshake();
      this.onStatus({ state: "disconnected" });
    }
  }

  async disconnect() {
    const device = this.device;
    this.device = null;
    this.twinReceiver.reset();
    this.clearHandshake();
    if (device?.opened) {
      await device.sendReport(
        VICO_HID_REPORT_ID,
        buildHidReport(COMMAND.DISPLAY_SUBSCRIBE, [0])
      ).catch(() => {});
    }
    device?.removeEventListener("inputreport", this.handleInputReport);
    if (device?.opened) await device.close();
    this.onStatus({ state: "disconnected" });
  }

  async send(command, payload) {
    if (!this.device?.opened) throw new Error("请先连接键盘");
    await this.device.sendReport(VICO_HID_REPORT_ID, buildHidReport(command, payload));
  }

  async sendOled(oled) {
    const frame = renderOledTemplate(oled);
    await this.send(COMMAND.OLED_META, [
      1, // protocol version
      128,
      64,
      Math.max(0, Math.min(100, oled.brightness || 100)),
      1, // format: row-major, 1-bit, MSB first
      OLED_BITMAP_BYTES & 0xff,
      OLED_BITMAP_BYTES >> 8
    ]);

    for (let offset = 0; offset < frame.length; offset += OLED_CHUNK_BYTES) {
      await this.send(COMMAND.OLED_BITMAP, [
        offset & 0xff,
        offset >> 8,
        ...frame.slice(offset, offset + OLED_CHUNK_BYTES)
      ]);
    }
  }

  async sync(profile) {
    for (const mapping of profile.mappings) {
      await this.send(COMMAND.SET_KEY, [mapping.key, ...encodeJson(mapping)]);
    }
    await this.sendOled(profile.oled);
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

    this.onStatus({ state: "connected", name: device.name || "Vico Keyboard" });
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
    const device = this.device;
    this.device = null;
    this.rx = null;
    this.tx = null;
    if (device?.gatt?.connected) device.gatt.disconnect();
    this.onStatus({ state: "disconnected" });
  }
}
