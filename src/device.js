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

export class VicoBleDevice {
  constructor(onStatus, onAck, onRuntimeSettings = () => {}, onVoice = () => {}) {
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
    this.removeBridgeListener = globalThis.window?.vico?.ble?.onEvent?.(
      (event) => this.handleBridgeEvent(event)
    );
  }

  clearConnectionState() {
    if (this.voiceExclusive) this.onVoice({ type:"error", message:"蓝牙 GATT 已断开，语音录音已取消" });
    this.connectedStatus = null;
    this.sessionActive = false;
    this.runtimeWriteQueue = Promise.resolve();
    this.voiceReceiver.reset();
    this.voiceExclusive = false;
  }

  bridge() {
    const bridge = globalThis.window?.vico?.ble;
    if (!bridge?.command) throw new Error("蓝牙后台服务尚未就绪，请重新启动软件");
    return bridge;
  }

  applyConnectedStatus(status) {
    this.connectedStatus = {
      state:"connected",
      name:status?.name || "Vico Keyboard",
      batteryPercent:status?.batteryPercent ?? null
    };
    this.sessionActive = true;
    this.onStatus(this.connectedStatus);
  }

  handleIncomingBytes(bytes) {
    const value = Uint8Array.from(bytes || []);
    if (this.voiceReceiver.accept(value)) return;
    const runtimeSettings = parseRuntimeSettingsPacket(value);
    if (runtimeSettings) {
      this.onRuntimeSettings(runtimeSettings);
      return;
    }
    this.onAck?.(new TextDecoder().decode(value));
  }

  handleBridgeEvent(event) {
    switch (event?.type) {
      case "connecting":
        this.onStatus({ state:"connecting", name:event.name || "Vico Keyboard" });
        break;
      case "connected":
        this.applyConnectedStatus(event.status);
        break;
      case "battery":
        if (this.connectedStatus) {
          this.connectedStatus = { ...this.connectedStatus, batteryPercent:event.batteryPercent };
          this.onStatus(this.connectedStatus);
        }
        break;
      case "data":
        this.handleIncomingBytes(event.bytes);
        break;
      case "unexpected-disconnect":
      case "disconnected":
        this.clearConnectionState();
        this.onStatus({ state:"disconnected" });
        break;
      default:
        break;
    }
  }

  async restore() {
    const status = await this.bridge().command("restore");
    if (status?.state === "connected") {
      this.applyConnectedStatus(status);
      await this.setVoiceSession(true).catch(() => {});
    } else if (status?.state === "unsupported") {
      this.onStatus(status);
    }
    return status;
  }

  async request() {
    await this.disconnectPromise.catch(() => {});
    this.disconnectPromise = Promise.resolve();
    this.onStatus({ state:"connecting", name:"Vico Keyboard" });
    const status = await this.bridge().command("connect");
    this.applyConnectedStatus(status);
    await this.setVoiceSession(true).catch(() => {});
    return status;
  }

  /** 新固件用该运行时包确认软件是否正在监听语音；旧固件会安全忽略。 */
  async setVoiceSession(enabled) {
    if (!this.sessionActive && enabled) return false;
    return this.bridge().command("write", {
      packets:[Array.from(buildVoiceSessionPacket(enabled))]
    });
  }

  async writeRuntimePacket(packet) {
    if (!this.sessionActive) return false;
    return this.writeRuntimePackets([packet]);
  }

  /** 兼容参考 GATT 项目的紧凑 JSON state/tool/text 状态格式。 */
  async writeClaudeStatus(status) {
    if (!this.sessionActive || this.voiceExclusive) return false;
    const payload = new TextEncoder().encode(JSON.stringify({
      state:String(status?.state || "offline").slice(0, 12),
      tool:String(status?.tool || "").slice(0, 14),
      text:String(status?.text || "Waiting for Claude Code").slice(0, 42)
    }));
    this.runtimeWriteQueue = this.runtimeWriteQueue.catch(() => {}).then(async () => {
      if (this.voiceExclusive) return false;
      return this.bridge().command("write", { packets:[Array.from(payload)] });
    });
    return this.runtimeWriteQueue;
  }

  async writeRuntimePackets(packets) {
    if (!this.sessionActive || this.voiceExclusive) return false;
    this.runtimeWriteQueue = this.runtimeWriteQueue.catch(() => {}).then(async () => {
      for (const packet of packets) {
        if (this.voiceExclusive) return false;
        await this.bridge().command("write", { packets:[Array.from(packet)] });
      }
      return true;
    });
    return this.runtimeWriteQueue;
  }

  disconnect() {
    const bridge = this.bridge();
    const wasActive = this.sessionActive;
    this.disconnectPromise = (wasActive
      ? bridge.command("write", { packets:[Array.from(buildVoiceSessionPacket(false))] }).catch(() => {})
      : Promise.resolve()
    ).then(() => bridge.command("disconnect")).catch(() => {});
    if (this.voiceExclusive) {
      this.onVoice({ type:"error", message:"蓝牙 GATT 已断开，语音录音已取消" });
    }
    this.clearConnectionState();
    this.onStatus({ state: "disconnected" });
  }
}
