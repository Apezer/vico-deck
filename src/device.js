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
import { buildVoiceSessionPacket, parseRuntimeSettingsPacket } from "./runtime-protocol.js";
import { VoiceTransferReceiver } from "./voice-protocol.js";

const VICO_USB_VENDOR_ID = 0x3343;
const VICO_USB_PRODUCT_ID = 0x83cf;
const VICO_VENDOR_USAGE_PAGE = 0xff00;
const VICO_VENDOR_USAGE = 0x01;
const COMMAND = {
  ...TWIN_COMMAND,
  OLED_META: 0x20,
  OLED_BITMAP: 0x21,
  COMMIT: 0x30,
  RUNTIME_UPDATE: 0x40
};
const OLED_CHUNK_BYTES = 58;
const RUNTIME_SETTINGS_CHANGED = 0x92;
const BATTERY_STATUS_CHANGED = 0x93;
const VOICE_PACKET = 0x94;

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
  constructor(onStatus, onFrame = () => {}, onRuntimeSettings = () => {}, onVoice = () => {}) {
    this.device = null;
    this.onStatus = onStatus;
    this.onFrame = onFrame;
    this.onRuntimeSettings = onRuntimeSettings;
    this.onVoice = onVoice;
    this.twinReceiver = new OledTwinReceiver();
    this.voiceExclusive = false;
    this.voiceReceiver = new VoiceTransferReceiver((event) => {
      this.voiceExclusive = event.type === "recording" || event.type === "transfer";
      onVoice(event);
    });
    this.helloResolver = null;
    this.helloRejecter = null;
    this.helloTimer = null;
    this.pendingCommand = null;
    this.connectedStatus = null;
    this.runtimeWriteQueue = Promise.resolve();
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
        profileCrcs: info.profileCrcs,
        batteryPercent: info.batteryPercent,
        batteryMillivolts: info.batteryMillivolts
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
        profileCrcs: info.profileCrcs,
        batteryPercent: info.batteryPercent,
        batteryMillivolts: info.batteryMillivolts
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
        const profileCount = payload.length >= 12 ? payload[11] : 0;
        const batteryOffset = 13 + profileCount * 4;
        const batteryMillivolts = payload.length >= batteryOffset + 3
          ? payload[batteryOffset + 1] | (payload[batteryOffset + 2] << 8)
          : 0;
        this.helloResolver?.({
          protocolVersion: payload[0],
          width: payload[1],
          height: payload[2],
          format: payload[3],
          firmwareVersion: `${payload[4]}.${payload[5]}.${payload[6]}`,
          profileCount,
          activeProfile: payload.length >= 13 ? payload[12] : 0,
          profileCrcs: Array.from({ length: payload.length >= 13 ? profileCount : 0 }, (_, index) => {
            const offset = 13 + index * 4;
            if (offset + 4 > payload.length) return 0;
            return (
              payload[offset] |
              (payload[offset + 1] << 8) |
              (payload[offset + 2] << 16) |
              (payload[offset + 3] << 24)
            ) >>> 0;
          }),
          batteryPercent:batteryMillivolts > 0 ? Math.min(100, payload[batteryOffset]) : null,
          batteryMillivolts:batteryMillivolts || null
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


    if (parsed.command === RUNTIME_SETTINGS_CHANGED && parsed.payload.length >= 2) {
      const pageNames = ["brand", "claude", "system", "clock", "device", "custom"];
      const page = pageNames[parsed.payload[0]];
      if (page) this.onRuntimeSettings({ page, autoClaude:parsed.payload[1] !== 0 });
      return;
    }

    if (parsed.command === BATTERY_STATUS_CHANGED && parsed.payload.length >= 3) {
      const batteryMillivolts = parsed.payload[1] | (parsed.payload[2] << 8);
      this.publishProfileStatus({
        batteryPercent:batteryMillivolts > 0 ? Math.min(100, parsed.payload[0]) : null,
        batteryMillivolts:batteryMillivolts || null
      });
      return;
    }

    if (parsed.command === VOICE_PACKET) {
      this.voiceReceiver.accept(parsed.payload);
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
      if (this.voiceExclusive) this.onVoice({ type:"error", message:"USB 连接已断开，语音录音已取消" });
      this.voiceReceiver.reset();
      this.voiceExclusive = false;
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
    if (this.voiceExclusive) this.onVoice({ type:"error", message:"USB 连接已断开，语音录音已取消" });
    this.voiceReceiver.reset();
    this.voiceExclusive = false;
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
    if (this.voiceExclusive) throw new Error("键盘正在进行语音输入，请松开旋钮后再操作");
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

  async writeRuntimePacket(packet) {
    if (!this.device?.opened) return false;
    return this.writeRuntimePackets([packet]);
  }

  async writeRuntimePackets(packets) {
    if (!this.device?.opened || this.voiceExclusive) return false;
    this.runtimeWriteQueue = this.runtimeWriteQueue.catch(() => {}).then(async () => {
      for (const packet of packets) {
        if (this.voiceExclusive) return false;
        await this.send(COMMAND.RUNTIME_UPDATE, Array.from(packet));
      }
      return true;
    });
    return this.runtimeWriteQueue;
  }
}

const BLE_SERVICE_UUID = "7b6a0001-7c6e-4b3d-9f5f-7669636f0001";
const BLE_RX_UUID = "7b6a0002-7c6e-4b3d-9f5f-7669636f0002";
const BLE_TX_UUID = "7b6a0003-7c6e-4b3d-9f5f-7669636f0003";
const BLE_BATTERY_SERVICE_UUID = "0000180f-0000-1000-8000-00805f9b34fb";
const BLE_BATTERY_LEVEL_UUID = "00002a19-0000-1000-8000-00805f9b34fb";
const BLE_CONNECT_TIMEOUT_MS = 10000;
const BLE_DISCONNECT_SETTLE_MS = 500;
const BLE_SERVICE_DISCOVERY_ATTEMPTS = 3;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withBleTimeout(operation, message, timeout = BLE_CONNECT_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    Promise.resolve(operation),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeout);
    })
  ]).finally(() => clearTimeout(timer));
}

export class VicoBleDevice {
  constructor(onStatus, onAck, onRuntimeSettings = () => {}, onVoice = () => {}) {
    this.device = null;
    // 保留已经成功发现过 Vico 服务的对象，避免手动断开后换成带旧 GATT 缓存的新对象。
    this.knownDevice = null;
    this.rx = null;
    this.tx = null;
    this.battery = null;
    this.connectedStatus = null;
    this.sessionActive = false;
    this.onStatus = onStatus;
    this.onAck = onAck;
    this.onRuntimeSettings = onRuntimeSettings;
    this.onVoice = onVoice;
    this.runtimeWriteQueue = Promise.resolve();
    this.voiceExclusive = false;
    this.voiceReceiver = new VoiceTransferReceiver((event) => {
      this.voiceExclusive = event.type === "recording" || event.type === "transfer";
      onVoice(event);
    });
    this.disconnectPromise = Promise.resolve();
    this.txHandler = (event) => {
      const view = event.target.value;
      const value = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      if (this.voiceReceiver.accept(value)) return;
      const runtimeSettings = parseRuntimeSettingsPacket(value);
      if (runtimeSettings) {
        this.onRuntimeSettings(runtimeSettings);
        return;
      }
      const text = new TextDecoder().decode(value);
      this.onAck?.(text);
    };
    this.batteryHandler = (event) => {
      const batteryPercent = event.target.value.getUint8(0);
      this.connectedStatus = { ...this.connectedStatus, batteryPercent };
      this.onStatus(this.connectedStatus);
    };
    this.disconnectHandler = () => {
      this.device?.removeEventListener("gattserverdisconnected", this.disconnectHandler);
      this.device = null;
      this.clearConnectionState();
      this.onStatus({ state: "disconnected" });
    };
  }

  clearConnectionState() {
    if (this.voiceExclusive) this.onVoice({ type:"error", message:"蓝牙 GATT 已断开，语音录音已取消" });
    this.tx?.removeEventListener("characteristicvaluechanged", this.txHandler);
    this.battery?.removeEventListener("characteristicvaluechanged", this.batteryHandler);
    this.rx = null;
    this.tx = null;
    this.battery = null;
    this.connectedStatus = null;
    this.sessionActive = false;
    this.voiceReceiver.reset();
    this.voiceExclusive = false;
  }

  /** 新固件用该运行时包确认软件是否正在监听语音；旧特征会被安全忽略。 */
  async setVoiceSession(enabled) {
    if (!this.rx || !this.device?.gatt?.connected) return false;
    const packet = buildVoiceSessionPacket(enabled);
    const operation = this.rx.properties?.write && this.rx.writeValueWithResponse
      ? this.rx.writeValueWithResponse(packet)
      : this.rx.writeValueWithoutResponse?.(packet);
    if (!operation) return false;
    await operation;
    return true;
  }

  async restore() {
    if (!navigator.bluetooth?.getDevices) return;
    const devices = await navigator.bluetooth.getDevices();
    const found = devices.find((device) => /vico keyboard/i.test(device.name || ""));
    if (found) await this.open(found);
  }

  async request() {
    if (!navigator.bluetooth) throw new Error("当前环境不支持蓝牙 GATT");

    // disconnect() 对 Web Bluetooth 来说是同步调用，但 Windows 释放底层连接需要时间。
    await this.disconnectPromise;

    if (this.knownDevice) {
      try {
        await this.open(this.knownDevice);
        return this.knownDevice;
      } catch {
        // 已知对象失效时继续尝试授权设备；不要要求用户重启整个软件。
      }
    }

    // 首次授权后直接复用浏览器保存的设备对象。这样即使键盘已被Windows HID连接、
    // 当前没有出现在扫描列表中，断开自定义GATT后仍可稳定重新连接。
    if (navigator.bluetooth.getDevices) {
      const devices = await navigator.bluetooth.getDevices();
      const authorized = devices.find((device) => /vico keyboard/i.test(device.name || ""));
      if (authorized) {
        try {
          await this.open(authorized);
          return authorized;
        } catch {
          // 缓存对象连接失败时清理旧链路，再回退到用户可见的设备扫描流程。
          if (authorized.gatt?.connected) authorized.gatt.disconnect();
          this.clearConnectionState();
        }
      }
    }

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "Vico Keyboard" }],
      optionalServices: [BLE_SERVICE_UUID, BLE_BATTERY_SERVICE_UUID]
    });
    await this.open(device);
    return device;
  }

  async open(device) {
    // “断开软件连接”不会破坏 Windows HID 正在共用的物理 BLE 链路。
    // 如果服务和特征仍然有效，直接恢复监听即可，无需再次执行慢速服务发现。
    if (this.device === device && device.gatt?.connected && this.rx && this.tx) {
      this.tx.removeEventListener("characteristicvaluechanged", this.txHandler);
      this.tx.addEventListener("characteristicvaluechanged", this.txHandler);
      if (this.battery) {
        this.battery.removeEventListener("characteristicvaluechanged", this.batteryHandler);
        this.battery.addEventListener("characteristicvaluechanged", this.batteryHandler);
      }
      await this.setVoiceSession(true).catch(() => {});
      this.sessionActive = true;
      this.onStatus(this.connectedStatus || {
        state:"connected",
        name:device.name || "Vico Keyboard",
        batteryPercent:null
      });
      return;
    }

    this.device?.removeEventListener("gattserverdisconnected", this.disconnectHandler);
    this.clearConnectionState();
    this.device = device;
    this.device.addEventListener("gattserverdisconnected", this.disconnectHandler);

    this.onStatus({ state: "connecting", name: device.name || "Vico Keyboard" });
    try {
      const { server, service } = await this.connectAndDiscoverVicoService(device);
      this.rx = await withBleTimeout(service.getCharacteristic(BLE_RX_UUID), "读取蓝牙发送通道超时");
      this.tx = await withBleTimeout(service.getCharacteristic(BLE_TX_UUID), "读取蓝牙通知通道超时");
      let batteryPercent = null;
      this.connectedStatus = { state:"connected", name:device.name || "Vico Keyboard", batteryPercent };

      // 标准HID Battery Service读取失败不影响Vico自定义GATT连接。
      try {
        const batteryService = await withBleTimeout(
          server.getPrimaryService(BLE_BATTERY_SERVICE_UUID),
          "读取电池服务超时",
          4000
        );
        this.battery = await withBleTimeout(
          batteryService.getCharacteristic(BLE_BATTERY_LEVEL_UUID),
          "读取电池特征超时",
          4000
        );
        const initialBattery = await withBleTimeout(this.battery.readValue(), "读取电量超时", 4000);
        batteryPercent = initialBattery.getUint8(0);
        if (this.battery.properties.notify) {
          await withBleTimeout(this.battery.startNotifications(), "订阅电量通知超时", 4000);
          this.battery.addEventListener("characteristicvaluechanged", this.batteryHandler);
        }
      } catch {
        this.battery = null;
      }

      if (this.tx.properties.notify) {
        await withBleTimeout(this.tx.startNotifications(), "订阅 Vico 状态通知超时");
        this.tx.addEventListener("characteristicvaluechanged", this.txHandler);
      }

      // 只有监听器安装完成后才允许固件发送录音，避免首包在页面准备前丢失。
      // 旧固件没有语音会话包；握手失败不应破坏原有 OLED/RGB 连接。
      await this.setVoiceSession(true).catch(() => {});

      this.connectedStatus = { ...this.connectedStatus, batteryPercent };
      this.knownDevice = device;
      this.sessionActive = true;
      this.onStatus(this.connectedStatus);
    } catch (error) {
      this.device?.removeEventListener("gattserverdisconnected", this.disconnectHandler);
      if (device.gatt?.connected) device.gatt.disconnect();
      this.device = null;
      this.clearConnectionState();
      this.onStatus({ state:"disconnected" });
      throw error;
    }
  }

  async writeRuntimePacket(packet) {
    if (!this.sessionActive || !this.rx || !this.device?.gatt?.connected) return false;
    return this.writeRuntimePackets([packet]);
  }

  /**
   * Windows 和 Chromium 在快速断开、重连时可能暂时返回旧的 GATT 服务缓存。
   * 服务发现失败后重新建立完整链路，避免把临时缓存问题误报为固件缺少服务。
   */
  async connectAndDiscoverVicoService(device) {
    let lastError = null;
    for (let attempt = 0; attempt < BLE_SERVICE_DISCOVERY_ATTEMPTS; attempt += 1) {
      try {
        const server = device.gatt.connected
          ? device.gatt
          : await withBleTimeout(device.gatt.connect(), "蓝牙连接超时，请关闭键盘后重试");
        const service = await withBleTimeout(
          server.getPrimaryService(BLE_SERVICE_UUID),
          "Vico 状态服务发现超时"
        );
        return { server, service };
      } catch (error) {
        lastError = error;
        // 这是内部恢复动作，不应触发普通断线处理器把正在重连的设备对象清空。
        device.removeEventListener("gattserverdisconnected", this.disconnectHandler);
        if (device.gatt?.connected) device.gatt.disconnect();
        if (attempt + 1 < BLE_SERVICE_DISCOVERY_ATTEMPTS) {
          await wait(BLE_DISCONNECT_SETTLE_MS * (attempt + 1));
          if (this.device === device) {
            device.addEventListener("gattserverdisconnected", this.disconnectHandler);
          }
        }
      }
    }
    throw new Error("没有发现 Vico 状态服务。已自动重试，请关闭再打开键盘蓝牙，或在 Windows 中重新连接后重试。", { cause:lastError });
  }

  /** 兼容参考 GATT 项目的紧凑 JSON state/tool/text 状态格式。 */
  async writeClaudeStatus(status) {
    if (!this.sessionActive || !this.rx || !this.device?.gatt?.connected || this.voiceExclusive) return false;
    const payload = new TextEncoder().encode(JSON.stringify({
      state:String(status?.state || "offline").slice(0, 12),
      tool:String(status?.tool || "").slice(0, 14),
      text:String(status?.text || "Waiting for Claude Code").slice(0, 42)
    }));
    this.runtimeWriteQueue = this.runtimeWriteQueue.catch(() => {}).then(async () => {
      if (this.voiceExclusive) return false;
      if (this.rx.properties.write) await this.rx.writeValueWithResponse(payload);
      else await this.rx.writeValueWithoutResponse(payload);
      return true;
    });
    return this.runtimeWriteQueue;
  }

  async writeRuntimePackets(packets) {
    if (!this.sessionActive || !this.rx || !this.device?.gatt?.connected || this.voiceExclusive) return false;
    this.runtimeWriteQueue = this.runtimeWriteQueue.catch(() => {}).then(async () => {
      for (const packet of packets) {
        if (this.voiceExclusive) return false;
        if (this.rx.properties.write) await this.rx.writeValueWithResponse(packet);
        else await this.rx.writeValueWithoutResponse(packet);
      }
      return true;
    });
    return this.runtimeWriteQueue;
  }

  disconnect() {
    // 键盘的 HID 与配置 GATT 共用同一条 Windows BLE 物理连接。这里仅暂停软件会话，
    // 不调用 gatt.disconnect()，否则 Windows 保留 HID 后 Chromium 可能无法重新发现服务。
    if (this.sessionActive && this.rx && this.device?.gatt?.connected) {
      this.disconnectPromise = this.setVoiceSession(false).catch(() => {});
    }
    if (this.voiceExclusive) this.onVoice({ type:"error", message:"蓝牙 GATT 已断开，语音录音已取消" });
    this.sessionActive = false;
    this.voiceExclusive = false;
    this.voiceReceiver.reset();
    this.tx?.removeEventListener("characteristicvaluechanged", this.txHandler);
    this.battery?.removeEventListener("characteristicvaluechanged", this.batteryHandler);
    this.onStatus({ state: "disconnected" });
  }
}
