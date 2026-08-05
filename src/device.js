import { OLED_BITMAP_BYTES, renderOledTemplate } from "./oled-bitmap.js";
import {
  OledTwinReceiver,
  TWIN_COMMAND,
  VICO_HID_REPORT_ID,
  buildHidReport,
  parseHidReport
} from "./twin-protocol.js";
import {
  PROFILE_COMMAND,
  PROFILE_PROTOCOL_VERSION,
  compileProfile,
  compiledProfileCrc,
  uint32ToBytes
} from "./profile-protocol.js";

const VICO_USB_VENDOR_ID = 0x3343;
const VICO_USB_PRODUCT_ID = 0x83cf;
const VICO_VENDOR_USAGE_PAGE = 0xff00;
const VICO_VENDOR_USAGE = 0x01;
const COMMAND = {
  ...TWIN_COMMAND,
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

const PROFILE_ERRORS = [
  "成功", "预设编号无效", "按键编号无效", "按键配置无效",
  "没有进行中的同步", "预设数据不完整", "预设校验失败",
  "键盘存储失败", "键盘正忙"
];

export class VicoDevice {
  constructor(onStatus, onFrame = () => {}) {
    this.device = null;
    this.onStatus = onStatus;
    this.onFrame = onFrame;
    this.twinReceiver = new OledTwinReceiver();
    this.helloResolver = null;
    this.helloRejecter = null;
    this.helloTimer = null;
    this.pendingCommand = null;
    this.connectedStatus = null;
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
        protocolVersion: info.protocolVersion,
        profileCount: info.profileCount,
        activeProfile: info.activeProfile,
        profileCrcs: info.profileCrcs
      });
      this.connectedStatus = {
        state: "connected",
        name: device.productName || "Vico Keyboard",
        vendorId: device.vendorId,
        productId: device.productId,
        firmwareVersion: info.firmwareVersion,
        protocolVersion: info.protocolVersion,
        profileCount: info.profileCount,
        activeProfile: info.activeProfile,
        profileCrcs: info.profileCrcs
      };
    } catch (error) {
      device.removeEventListener("inputreport", this.handleInputReport);
      if (device.opened) await device.close().catch(() => {});
      this.device = null;
      this.clearHandshake();
      this.clearPendingCommand(new Error("设备连接已关闭"));
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

  clearPendingCommand(error) {
    if (!this.pendingCommand) return;
    clearTimeout(this.pendingCommand.timer);
    if (error) this.pendingCommand.reject(error);
    this.pendingCommand = null;
  }

  publishProfileStatus(patch) {
    this.connectedStatus = { ...this.connectedStatus, ...patch };
    this.onStatus(this.connectedStatus);
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
          firmwareVersion: `${payload[4]}.${payload[5]}.${payload[6]}`,
          profileCount: payload.length >= 12 ? payload[11] : 0,
          activeProfile: payload.length >= 13 ? payload[12] : 0,
          profileCrcs: Array.from({ length: payload.length >= 13 ? payload[11] : 0 }, (_, index) => {
            const offset = 13 + index * 4;
            if (offset + 4 > payload.length) return 0;
            return (
              payload[offset] |
              (payload[offset + 1] << 8) |
              (payload[offset + 2] << 16) |
              (payload[offset + 3] << 24)
            ) >>> 0;
          })
        });
      } else {
        this.helloRejecter?.(new Error("设备身份握手无效，连接已取消"));
      }
      return;
    }

    if (parsed.command === PROFILE_COMMAND.ACK && parsed.payload.length >= 4) {
      const [acknowledgedCommand, result, slot, activeProfile] = parsed.payload;
      if (this.pendingCommand?.command === acknowledgedCommand) {
        const pending = this.pendingCommand;
        clearTimeout(pending.timer);
        this.pendingCommand = null;
        if (result === 0) pending.resolve({ slot, activeProfile });
        else pending.reject(new Error(PROFILE_ERRORS[result] || `键盘返回错误 ${result}`));
      }
      return;
    }

    if (parsed.command === PROFILE_COMMAND.ACTIVE_CHANGED && parsed.payload.length >= 1) {
      const activeProfile = parsed.payload[0];
      const profileCount = this.connectedStatus?.profileCount || 0;
      if (activeProfile < profileCount) this.publishProfileStatus({ activeProfile });
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
      this.clearPendingCommand(new Error("键盘已断开"));
      this.connectedStatus = null;
      this.onStatus({ state: "disconnected" });
    }
  }

  async disconnect() {
    const device = this.device;
    this.device = null;
    this.twinReceiver.reset();
    this.clearHandshake();
    this.clearPendingCommand(new Error("键盘已断开"));
    if (device?.opened) {
      await device.sendReport(
        VICO_HID_REPORT_ID,
        buildHidReport(COMMAND.DISPLAY_SUBSCRIBE, [0])
      ).catch(() => {});
    }
    device?.removeEventListener("inputreport", this.handleInputReport);
    if (device?.opened) await device.close();
    this.onStatus({ state: "disconnected" });
    this.connectedStatus = null;
  }

  async send(command, payload) {
    if (!this.device?.opened) throw new Error("请先连接键盘");
    await this.device.sendReport(VICO_HID_REPORT_ID, buildHidReport(command, payload));
  }

  async requestCommand(command, payload, timeoutMs = 1800) {
    if (this.pendingCommand) throw new Error("上一条键盘命令尚未完成");

    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingCommand?.command === command) this.pendingCommand = null;
        reject(new Error(`键盘未确认命令 0x${command.toString(16)}`));
      }, timeoutMs);
      this.pendingCommand = { command, resolve, reject, timer };
    });

    try {
      await this.send(command, payload);
    } catch (error) {
      this.clearPendingCommand();
      throw error;
    }
    return response;
  }

  async sendOled(oled) {
    const frame = renderOledTemplate(oled);
    await this.send(COMMAND.OLED_META, [
      1, // 协议版本
      128,
      64,
      Math.max(0, Math.min(100, oled.brightness || 100)),
      1, // 格式：行优先、1 位、最高有效位优先
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

  async syncProfile(profile, activate = true) {
    if ((this.connectedStatus?.protocolVersion || 0) < 2) {
      throw new Error("键盘固件版本过旧，不支持五预设同步");
    }
    const slot = Number(profile.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= 5) throw new Error("预设槽位无效");

    const compiled = compileProfile(profile);
    const crc = compiledProfileCrc(compiled);
    await this.requestCommand(PROFILE_COMMAND.BEGIN, [PROFILE_PROTOCOL_VERSION, slot]);
    for (const item of compiled) {
      await this.requestCommand(PROFILE_COMMAND.SET_KEY, [slot, item.key - 1, ...item.bytes]);
    }
    const ack = await this.requestCommand(PROFILE_COMMAND.COMMIT, [slot, activate ? 1 : 0, ...uint32ToBytes(crc)], 3500);

    const profileCrcs = [...(this.connectedStatus.profileCrcs || Array(5).fill(0))];
    profileCrcs[slot] = crc;
    this.publishProfileStatus({ profileCrcs, activeProfile:ack.activeProfile });
    return { slot, crc, activeProfile:ack.activeProfile, profileCrcs };
  }

  async syncAll(profiles, activeProfileId) {
    for (const profile of [...profiles].sort((a, b) => a.slot - b.slot)) {
      await this.syncProfile(profile, false);
    }
    const active = profiles.find((profile) => profile.id === activeProfileId) || profiles[0];
    const ack = await this.requestCommand(PROFILE_COMMAND.SET_ACTIVE, [active.slot]);
    this.publishProfileStatus({ activeProfile:ack.activeProfile });
    return { activeProfile:ack.activeProfile, profileCrcs:this.connectedStatus.profileCrcs };
  }

  /** 切换预设槽位，但不重写任何按键绑定。 */
  async activateProfile(slot) {
    if ((this.connectedStatus?.protocolVersion || 0) < 2) {
      throw new Error("键盘固件版本过旧，不支持预设切换");
    }
    const profileCount = this.connectedStatus?.profileCount || 5;
    if (!Number.isInteger(slot) || slot < 0 || slot >= profileCount) {
      throw new Error("预设槽位无效");
    }

    const ack = await this.requestCommand(PROFILE_COMMAND.SET_ACTIVE, [slot]);
    this.publishProfileStatus({ activeProfile:ack.activeProfile });
    return ack.activeProfile;
  }

  async sync(profile) {
    return this.syncProfile(profile, true);
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
