export const PROFILE_COUNT = 5;
export const KEY_COUNT = 8;
export const PROFILE_PROTOCOL_VERSION = 1;
export const BLE_PROFILE_MAGIC = 0xb7;

export const PROFILE_COMMAND = Object.freeze({
  BEGIN: 0x10,
  SET_KEY: 0x11,
  COMMIT: 0x12,
  SET_ACTIVE: 0x13,
  GET_CRC: 0x14,
  HELLO: 0x01,
  HELLO_ACK: 0x81,
  ACK: 0x90,
  ACTIVE_CHANGED: 0x91,
  CRC: 0x94
});

/**
 * 给蓝牙 GATT 配置消息增加独立包头，避免与 OLED 运行时包、语音包和
 * Claude JSON 共用 characteristic 时产生误判。预设命令本身与 USB 保持一致。
 */
export function buildBleProfilePacket(command, payload = []) {
  return Uint8Array.from([
    BLE_PROFILE_MAGIC,
    PROFILE_PROTOCOL_VERSION,
    command & 0xff,
    ...payload
  ]);
}

/** 解析一份蓝牙预设消息；非预设通道的数据返回 null，交给其他协议处理。 */
export function parseBleProfilePacket(bytes) {
  const packet = Uint8Array.from(bytes || []);
  if (packet.length < 3 || packet[0] !== BLE_PROFILE_MAGIC) return null;
  if (packet[1] !== PROFILE_PROTOCOL_VERSION) {
    throw new Error(`不支持的蓝牙预设协议版本：${packet[1]}`);
  }
  return { command:packet[2], payload:packet.slice(3) };
}

export const ACTION_TYPE = Object.freeze({
  NONE: 0,
  KEYBOARD: 1,
  CONSUMER: 2,
  FN: 3
});

export const MODIFIER = Object.freeze({
  CTRL: 1 << 0,
  SHIFT: 1 << 1,
  ALT: 1 << 2,
  GUI: 1 << 3
});

const SPECIAL_KEYS = Object.freeze({
  SPACE: 0x20,
  PLUS: 0x2b,
  MINUS: 0x2d,
  EQUAL: 0x3d,
  COMMA: 0x2c,
  PERIOD: 0x2e,
  SLASH: 0x2f,
  SEMICOLON: 0x3b,
  APOSTROPHE: 0x27,
  BACKTICK: 0x60,
  BACKSLASH: 0x5c,
  LEFT_BRACKET: 0x5b,
  RIGHT_BRACKET: 0x5d,
  ENTER: 0xb0,
  ESC: 0xb1,
  ESCAPE: 0xb1,
  BACKSPACE: 0xb2,
  TAB: 0xb3,
  CAPS_LOCK: 0xc1,
  PRINT_SCREEN: 0xce,
  DELETE: 0xd4,
  ARROW_RIGHT: 0xd7,
  RIGHT: 0xd7,
  ARROW_LEFT: 0xd8,
  LEFT: 0xd8,
  ARROW_DOWN: 0xd9,
  DOWN: 0xd9,
  ARROW_UP: 0xda,
  UP: 0xda,
  INSERT: 0xd1,
  HOME: 0xd2,
  PAGE_UP: 0xd3,
  END: 0xd5,
  PAGE_DOWN: 0xd6,
  NUMPAD_ENTER: 0xe0,
  NUMPAD_1: 0xe1,
  NUMPAD_2: 0xe2,
  NUMPAD_3: 0xe3,
  NUMPAD_4: 0xe4,
  NUMPAD_5: 0xe5,
  NUMPAD_6: 0xe6,
  NUMPAD_7: 0xe7,
  NUMPAD_8: 0xe8,
  NUMPAD_9: 0xe9,
  NUMPAD_0: 0xea,
  NUMPAD_PERIOD: 0xeb,
  NUMPAD_DIVIDE: 0xdc,
  NUMPAD_MULTIPLY: 0xdd,
  NUMPAD_MINUS: 0xde,
  NUMPAD_PLUS: 0xdf
});

const CONSUMER_ACTIONS = Object.freeze({
  PREVIOUS_TRACK: 1,
  PLAY_PAUSE: 2,
  NEXT_TRACK: 3,
  MUTE: 4,
  VOLUME_DOWN: 5,
  VOLUME_UP: 6,
  STOP: 7,
  WWW_HOME: 8,
  LOCAL_BROWSER: 9,
  CALCULATOR: 10,
  WWW_BOOKMARKS: 11,
  WWW_SEARCH: 12,
  WWW_STOP: 13,
  WWW_BACK: 14,
  MEDIA_SELECT: 15,
  EMAIL_READER: 16
});

const SYSTEM_SHORTCUTS = Object.freeze({
  LOCK_SCREEN: "Win+L",
  SHOW_DESKTOP: "Win+D",
  SCREENSHOT: "Win+Shift+S",
  FILE_EXPLORER: "Win+E",
  WINDOWS_SETTINGS: "Win+I",
  TASK_MANAGER: "Ctrl+Shift+Esc",
  RUN_DIALOG: "Win+R",
  CLIPBOARD_HISTORY: "Win+V",
  WINDOWS_SEARCH: "Win+S",
  EMOJI_PANEL: "Win+PERIOD"
});

const MODIFIER_TOKENS = Object.freeze({
  CTRL: MODIFIER.CTRL,
  CONTROL: MODIFIER.CTRL,
  SHIFT: MODIFIER.SHIFT,
  ALT: MODIFIER.ALT,
  WIN: MODIFIER.GUI,
  WINDOWS: MODIFIER.GUI,
  GUI: MODIFIER.GUI,
  CMD: MODIFIER.GUI,
  COMMAND: MODIFIER.GUI
});

function functionKeyCode(token) {
  const match = /^F([1-9]|1\d|2[0-4])$/.exec(token);
  if (!match) return null;
  const number = Number(match[1]);
  return number <= 12 ? 0xc1 + number : 0xe3 + number;
}

function keyCodeForToken(rawToken) {
  const token = rawToken.trim();
  const upper = token.toUpperCase().replaceAll(" ", "_");
  if (SPECIAL_KEYS[upper] != null) return SPECIAL_KEYS[upper];
  const fKey = functionKeyCode(upper);
  if (fKey != null) return fKey;
  if (token.length === 1 && token.charCodeAt(0) <= 0x7f) {
    return token.toLowerCase().charCodeAt(0);
  }
  throw new Error(`不支持的按键：${rawToken}`);
}

function compileShortcut(shortcut) {
  const tokens = String(shortcut || "").split("+").map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) throw new Error("快捷键不能为空");

  let modifiers = 0;
  let keycode = 0;
  for (const token of tokens) {
    const modifier = MODIFIER_TOKENS[token.toUpperCase()];
    if (modifier) {
      modifiers |= modifier;
      continue;
    }
    if (keycode !== 0) throw new Error(`快捷键只能包含一个普通按键：${shortcut}`);
    keycode = keyCodeForToken(token);
  }

  if (modifiers === 0 && keycode === 0) throw new Error("快捷键没有有效内容");
  return { action:ACTION_TYPE.KEYBOARD, modifiers, keycode, consumer:0 };
}

export function compileMapping(mapping) {
  if (mapping.type === "layer" && String(mapping.value).toUpperCase() === "FN") {
    return { action:ACTION_TYPE.FN, modifiers:0, keycode:0, consumer:0 };
  }

  if (mapping.type === "media") {
    const consumer = CONSUMER_ACTIONS[String(mapping.value).toUpperCase()];
    if (!consumer) throw new Error(`不支持的媒体功能：${mapping.value}`);
    return { action:ACTION_TYPE.CONSUMER, modifiers:0, keycode:0, consumer };
  }

  if (mapping.type === "system") {
    if (mapping.value === "DO_NOTHING") {
      return { action:ACTION_TYPE.NONE, modifiers:0, keycode:0, consumer:0 };
    }
    const shortcut = SYSTEM_SHORTCUTS[mapping.value];
    if (!shortcut) throw new Error(`不支持的系统功能：${mapping.value}`);
    return compileShortcut(shortcut);
  }

  if (mapping.type === "shortcut") return compileShortcut(mapping.value);
  if (mapping.type === "keyboard") {
    return { action:ACTION_TYPE.KEYBOARD, modifiers:0, keycode:keyCodeForToken(mapping.value), consumer:0 };
  }

  throw new Error(`不支持的按键类型：${mapping.type}`);
}

export function bindingToBytes(binding) {
  return Uint8Array.of(
    binding.action,
    binding.modifiers,
    binding.keycode,
    binding.consumer & 0xff,
    binding.consumer >> 8
  );
}

export function compileProfile(profile) {
  const mappings = [...profile.mappings].sort((a, b) => a.key - b.key);
  if (mappings.length !== KEY_COUNT || mappings.some((mapping, index) => mapping.key !== index + 1)) {
    throw new Error(`${profile.name || "预设"} 必须包含 KEY1～KEY8`);
  }

  return mappings.map((mapping) => {
    const binding = compileMapping(mapping);
    return { key:mapping.key, binding, bytes:bindingToBytes(binding) };
  });
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function compiledProfileCrc(compiledProfile) {
  const bytes = new Uint8Array(compiledProfile.length * 5);
  compiledProfile.forEach((item, index) => bytes.set(item.bytes, index * 5));
  return crc32(bytes);
}

export function profileCrc(profile) {
  return compiledProfileCrc(compileProfile(profile));
}

export function uint32ToBytes(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}
