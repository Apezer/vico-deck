const VOICE_MAGIC = 0xa6;
const VOICE_VERSION = 2;

export const VOICE_PACKET = Object.freeze({
  RECORDING_STARTED: 1,
  RECORDING_STOPPED: 2,
  AUDIO_CHUNK: 3,
  TRANSFER_END: 4,
  ERROR: 5
});

function uint16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint32(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

export function voiceCrc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

export function encodePcm16Wav(pcm, sampleRate) {
  const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
  const wav = new Uint8Array(44 + bytes.length);
  const view = new DataView(wav.buffer);
  const ascii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) wav[offset + index] = value.charCodeAt(index);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + bytes.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, bytes.length, true);
  wav.set(bytes, 44);
  return wav;
}

const errorMessages = {
  1: "键盘麦克风初始化失败，请检查 INMP441 接线",
  2: "音频发送速度不足，键盘缓冲区已满，请缩短录音或改用 USB",
  3: "没有可用的 Vico 软件连接，请先连接 USB 或蓝牙 GATT"
};

/**
 * 接收 USB/BLE 共用的实时语音流。开始包只声明最大时长，音频分片在录音
 * 过程中持续到达；停止包再给出最终长度和 CRC32。只有顺序、长度和校验都
 * 正确时才生成 WAV，避免把丢包音频交给云端识别。
 */
export class VoiceTransferReceiver {
  constructor(onEvent = () => {}) {
    this.onEvent = onEvent;
    this.reset();
  }

  reset() {
    this.sessionId = 0;
    this.sampleRate = 0;
    this.expectedBytes = 0;
    this.expectedCrc = 0;
    this.receivedBytes = 0;
    this.maximumBytes = 0;
    this.lastProgressPercent = -1;
    this.lastProgressAt = 0;
    this.stopped = false;
    this.pcm = null;
  }

  accept(value) {
    const bytes = value instanceof Uint8Array
      ? value
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (bytes.length < 3 || bytes[0] !== VOICE_MAGIC) return false;
    if (bytes[1] !== VOICE_VERSION) {
      this.onEvent({ type:"error", message:`不支持的语音协议版本 ${bytes[1]}` });
      return true;
    }

    const type = bytes[2];
    const sessionId = bytes.length >= 5 ? uint16(bytes, 3) : 0;
    if (type === VOICE_PACKET.RECORDING_STARTED && bytes.length >= 9) {
      this.reset();
      this.sessionId = sessionId;
      this.sampleRate = uint16(bytes, 5);
      const maxSeconds = bytes[7];
      const codec = bytes[8];
      this.maximumBytes = this.sampleRate * 2 * maxSeconds;
      if (!this.sampleRate || !maxSeconds || codec !== 0 || this.maximumBytes > 2 * 1024 * 1024) {
        this.onEvent({ type:"error", message:"键盘返回了无效的语音流参数" });
        this.reset();
        return true;
      }
      this.pcm = new Uint8Array(this.maximumBytes);
      this.onEvent({ type:"recording", sessionId, sampleRate:this.sampleRate, maxSeconds, codec:"pcm16" });
      return true;
    }
    if (type === VOICE_PACKET.RECORDING_STOPPED && bytes.length >= 15) {
      const total = uint32(bytes, 5);
      const crc = uint32(bytes, 9);
      const sampleRate = uint16(bytes, 13);
      if (!this.pcm || sessionId !== this.sessionId || sampleRate !== this.sampleRate ||
          total > this.maximumBytes || total % 2 !== 0 || this.receivedBytes > total) {
        this.onEvent({ type:"error", message:"键盘返回了无效的录音元数据" });
        this.reset();
        return true;
      }
      this.expectedBytes = total;
      this.expectedCrc = crc;
      this.stopped = true;
      this.onEvent({
        type:"transfer",
        sessionId,
        received:this.receivedBytes,
        total,
        progress:total ? this.receivedBytes / total : 1,
        recording:false
      });
      return true;
    }
    if (type === VOICE_PACKET.AUDIO_CHUNK && bytes.length > 9) {
      const offset = uint32(bytes, 5);
      const chunk = bytes.subarray(9);
      const limit = this.stopped ? this.expectedBytes : this.maximumBytes;
      if (!this.pcm || sessionId !== this.sessionId || offset !== this.receivedBytes ||
          offset + chunk.length > limit) {
        this.onEvent({ type:"error", message:"语音分片丢失或顺序错误，请重新录音" });
        this.reset();
        return true;
      }
      this.pcm.set(chunk, offset);
      this.receivedBytes += chunk.length;
      const progress = this.stopped
        ? (this.expectedBytes ? this.receivedBytes / this.expectedBytes : 1)
        : this.receivedBytes / this.maximumBytes;
      const percent = Math.floor(progress * 100);
      const now = Date.now();
      // 录音流包含大量小包；最多每 100ms 刷新一次 React，避免界面拖慢接收。
      if (now - this.lastProgressAt >= 100 || (this.stopped && this.receivedBytes === this.expectedBytes)) {
        this.lastProgressAt = now;
        this.lastProgressPercent = percent;
        this.onEvent({
          type:"transfer",
          sessionId,
          received:this.receivedBytes,
          total:this.stopped ? this.expectedBytes : this.maximumBytes,
          progress,
          recording:!this.stopped
        });
      }
      return true;
    }
    if (type === VOICE_PACKET.TRANSFER_END && bytes.length >= 13) {
      const total = uint32(bytes, 5);
      const crc = uint32(bytes, 9);
      const pcm = this.pcm?.slice(0, total);
      if (!pcm || !this.stopped || sessionId !== this.sessionId || total !== this.expectedBytes ||
          this.receivedBytes !== total || crc !== this.expectedCrc || voiceCrc32(pcm) !== crc) {
        this.onEvent({ type:"error", message:"录音校验失败，请重新录音" });
        this.reset();
        return true;
      }
      const wavBytes = encodePcm16Wav(pcm, this.sampleRate);
      const complete = {
        type:"complete",
        source:"keyboard",
        sessionId,
        sampleRate:this.sampleRate,
        duration:total / (this.sampleRate * 2),
        wavBytes
      };
      this.reset();
      this.onEvent(complete);
      return true;
    }
    if (type === VOICE_PACKET.ERROR && bytes.length >= 6) {
      this.onEvent({ type:"error", sessionId, message:errorMessages[bytes[5]] || `键盘录音错误 ${bytes[5]}` });
      this.reset();
      return true;
    }
    return true;
  }
}

export function buildVoicePacket(type, sessionId, payload = []) {
  return Uint8Array.from([
    VOICE_MAGIC,
    VOICE_VERSION,
    type,
    sessionId & 0xff,
    sessionId >> 8,
    ...payload
  ]);
}
