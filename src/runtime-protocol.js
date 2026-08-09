export const RUNTIME_PACKET_BYTES = 32;

export const RUNTIME_PAGE = Object.freeze({
  BRAND: 0,
  CLAUDE: 1,
  SYSTEM: 2,
  CLOCK: 3,
  DEVICE: 4,
  CUSTOM: 5
});

export const RUNTIME_PAGE_NAME = Object.freeze({
  brand: RUNTIME_PAGE.BRAND,
  claude: RUNTIME_PAGE.CLAUDE,
  system: RUNTIME_PAGE.SYSTEM,
  clock: RUNTIME_PAGE.CLOCK,
  device: RUNTIME_PAGE.DEVICE,
  custom: RUNTIME_PAGE.CUSTOM
});

const CLAUDE_STATE = Object.freeze({
  offline: 0,
  ready: 1,
  working: 2,
  tool: 3,
  waiting: 4,
  done: 5,
  error: 6
});

const CLAUDE_FALLBACK_LABEL = Object.freeze({
  offline:"Claude offline",
  ready:"Claude ready",
  working:"Thinking",
  tool:"Using tool",
  waiting:"Needs input",
  done:"Task complete",
  error:"Claude error"
});

const PACKET_MAGIC = 0x56;
const PACKET_VERSION = 1;
const PACKET_STATUS = 1;
const PACKET_SETTINGS = 2;
const PACKET_BITMAP_BEGIN = 3;
const PACKET_BITMAP_CHUNK = 4;
const PACKET_BITMAP_COMMIT = 5;
const PACKET_CLAUDE_TEXT = 6;
const PACKET_RGB_SETTINGS = 7;
const LABEL_BYTES = 16;
const UNKNOWN_METRIC = 0xff;

function checksum(bytes) {
  let value = 0;
  for (let index = 0; index < bytes.length - 1; index += 1) value ^= bytes[index];
  return value;
}

function metric(value) {
  if (!Number.isFinite(value)) return UNKNOWN_METRIC;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function writeAscii(bytes, offset, text, maximum) {
  const clean = String(text || "").replace(/[^\x20-\x7e]/g, " ").trim().slice(0, maximum);
  for (let index = 0; index < clean.length; index += 1) bytes[offset + index] = clean.charCodeAt(index);
  return clean.length;
}

function packet(type) {
  const bytes = new Uint8Array(RUNTIME_PACKET_BYTES);
  bytes[0] = PACKET_MAGIC;
  bytes[1] = PACKET_VERSION;
  bytes[2] = type;
  return bytes;
}

/** 将电脑和 Claude Code 的最新状态编码为固定长度运行时数据包。 */
export function buildRuntimeStatusPacket(claudeStatus = {}, systemStatus = {}, now = new Date()) {
  const bytes = packet(PACKET_STATUS);
  bytes[3] = CLAUDE_STATE[claudeStatus.state] ?? CLAUDE_STATE.offline;
  bytes[4] = metric(systemStatus.cpu);
  bytes[5] = metric(systemStatus.gpu);
  bytes[6] = metric(systemStatus.memory);
  bytes[7] = metric(systemStatus.temperature);
  bytes[8] = now.getHours();
  bytes[9] = now.getMinutes();
  bytes[10] = now.getMonth() + 1;
  bytes[11] = now.getDate();
  bytes[12] = now.getDay();
  bytes[13] = systemStatus.online === false ? 0 : 1;
  bytes[14] = writeAscii(bytes, 15, claudeStatus.tool, LABEL_BYTES);
  bytes[RUNTIME_PACKET_BYTES - 1] = checksum(bytes);
  return bytes;
}

/** 单独传输 Coding 页面第二行文本，保持与参考 GATT 项目的 state/tool/text 结构一致。 */
export function buildRuntimeClaudeTextPacket(claudeStatus = {}, now = new Date()) {
  const bytes = packet(PACKET_CLAUDE_TEXT);
  const text = claudeStatus.text || CLAUDE_FALLBACK_LABEL[claudeStatus.state] || "Claude Code";
  bytes[3] = writeAscii(bytes, 4, text, 21);
  if (bytes[3] === 0) {
    bytes[3] = writeAscii(bytes, 4, CLAUDE_FALLBACK_LABEL[claudeStatus.state] || "Claude Code", 21);
  }
  bytes[25] = Math.max(0, Math.min(
    255,
    Number(claudeStatus.activeSessions) || (claudeStatus.state === "offline" ? 0 : 1)
  ));
  const activityAgeSeconds = Math.max(0, Math.min(
    0xffff,
    Math.floor((now.getTime() - Number(claudeStatus.updatedAt || now.getTime())) / 1000)
  ));
  bytes[26] = activityAgeSeconds & 0xff;
  bytes[27] = activityAgeSeconds >> 8;
  bytes[RUNTIME_PACKET_BYTES - 1] = checksum(bytes);
  return bytes;
}

export function buildRuntimeStatusPackets(claudeStatus = {}, systemStatus = {}, now = new Date()) {
  return [
    buildRuntimeStatusPacket(claudeStatus, systemStatus, now),
    buildRuntimeClaudeTextPacket(claudeStatus, now)
  ];
}

/** 编码 OLED 默认页面和 Claude 自动覆盖设置。 */
export function buildRuntimeSettingsPacket(settings = {}) {
  const bytes = packet(PACKET_SETTINGS);
  bytes[3] = RUNTIME_PAGE_NAME[settings.page] ?? RUNTIME_PAGE.BRAND;
  bytes[4] = settings.autoClaude === false ? 0 : 1;
  bytes[RUNTIME_PACKET_BYTES - 1] = checksum(bytes);
  return bytes;
}

/** 编码 RGB 灯效、亮度、速度、总开关和常亮颜色，供 USB 与 BLE 共用。 */
export function buildRgbSettingsPacket(settings = {}) {
  const bytes = packet(PACKET_RGB_SETTINGS);
  bytes[3] = Math.max(0, Math.min(7, Number(settings.effect) || 0));
  bytes[4] = Math.max(25, Math.min(100, Number(settings.brightness) || 50));
  bytes[5] = Math.max(50, Math.min(200, Number(settings.speed) || 100));
  bytes[6] = settings.enabled === false ? 0 : 1;
  const color = /^#[0-9a-f]{6}$/i.test(settings.color || "") ? settings.color.slice(1) : "D6FF38";
  bytes[7] = Number.parseInt(color.slice(0, 2), 16);
  bytes[8] = Number.parseInt(color.slice(2, 4), 16);
  bytes[9] = Number.parseInt(color.slice(4, 6), 16);
  bytes[RUNTIME_PACKET_BYTES - 1] = checksum(bytes);
  return bytes;
}

export function validateRuntimePacket(bytes) {
  return bytes instanceof Uint8Array
    && bytes.length === RUNTIME_PACKET_BYTES
    && bytes[0] === PACKET_MAGIC
    && bytes[1] === PACKET_VERSION
    && bytes[RUNTIME_PACKET_BYTES - 1] === checksum(bytes);
}

export function parseRuntimeSettingsPacket(bytes) {
  if (!validateRuntimePacket(bytes) || bytes[2] !== PACKET_SETTINGS) return null;
  const page = Object.entries(RUNTIME_PAGE_NAME).find(([, value]) => value === bytes[3])?.[0];
  return page ? { page, autoClaude:bytes[4] !== 0 } : null;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

function writeUint32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

/** 将 1024 字节自定义位图拆成 USB 与 BLE 共用的可靠分片包。 */
export function buildRuntimeBitmapPackets(bitmap) {
  if (!(bitmap instanceof Uint8Array) || bitmap.length !== 1024) {
    throw new Error("自定义 OLED 位图必须正好为 1024 字节");
  }

  const expectedCrc = crc32(bitmap);
  const packets = [];
  const begin = packet(PACKET_BITMAP_BEGIN);
  begin[3] = bitmap.length & 0xff;
  begin[4] = bitmap.length >>> 8;
  writeUint32(begin, 5, expectedCrc);
  begin[RUNTIME_PACKET_BYTES - 1] = checksum(begin);
  packets.push(begin);

  for (let offset = 0; offset < bitmap.length; offset += 26) {
    const chunk = packet(PACKET_BITMAP_CHUNK);
    chunk[3] = offset & 0xff;
    chunk[4] = offset >>> 8;
    chunk.set(bitmap.slice(offset, offset + 26), 5);
    chunk[RUNTIME_PACKET_BYTES - 1] = checksum(chunk);
    packets.push(chunk);
  }

  const commit = packet(PACKET_BITMAP_COMMIT);
  writeUint32(commit, 3, expectedCrc);
  commit[RUNTIME_PACKET_BYTES - 1] = checksum(commit);
  packets.push(commit);
  return packets;
}
