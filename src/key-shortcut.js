/**
 * 将 KeyboardEvent.code 转换为固件按键协议使用的稳定名称。
 * 使用 code 而不是 key，避免 Shift 改变字符后丢失原始按键位置。
 */
const CODE_TOKENS = Object.freeze({
  Enter:"ENTER",
  Escape:"ESC",
  Backspace:"BACKSPACE",
  Tab:"TAB",
  Space:"SPACE",
  CapsLock:"CAPS_LOCK",
  Delete:"DELETE",
  Insert:"INSERT",
  Home:"HOME",
  End:"END",
  PageUp:"PAGE_UP",
  PageDown:"PAGE_DOWN",
  ArrowLeft:"ARROW_LEFT",
  ArrowRight:"ARROW_RIGHT",
  ArrowUp:"ARROW_UP",
  ArrowDown:"ARROW_DOWN",
  PrintScreen:"PRINT_SCREEN",
  Backquote:"BACKTICK",
  Minus:"MINUS",
  Equal:"EQUAL",
  BracketLeft:"LEFT_BRACKET",
  BracketRight:"RIGHT_BRACKET",
  Backslash:"BACKSLASH",
  Semicolon:"SEMICOLON",
  Quote:"APOSTROPHE",
  Comma:"COMMA",
  Period:"PERIOD",
  Slash:"SLASH",
  NumpadAdd:"NUMPAD_PLUS",
  NumpadSubtract:"NUMPAD_MINUS",
  NumpadMultiply:"NUMPAD_MULTIPLY",
  NumpadDivide:"NUMPAD_DIVIDE",
  NumpadDecimal:"NUMPAD_PERIOD",
  NumpadEnter:"NUMPAD_ENTER"
});

const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight",
  "ShiftLeft", "ShiftRight",
  "AltLeft", "AltRight",
  "MetaLeft", "MetaRight"
]);

function primaryToken(event) {
  const code = String(event?.code || "");
  if (MODIFIER_CODES.has(code)) return null;
  if (CODE_TOKENS[code]) return CODE_TOKENS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return `NUMPAD_${code.slice(6)}`;

  // 测试环境或少数 WebView 可能不提供 code，使用 key 做安全回退。
  const key = String(event?.key || "");
  if (key.length === 1 && /^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  if (key === " ") return "SPACE";
  return null;
}

/**
 * 把一次真实键盘按下转换成可持久化的 Vico 快捷键，例如 Ctrl+Shift+P。
 * 单独按下修饰键时返回 null，调用方继续等待普通按键。
 */
export function shortcutFromKeyboardEvent(event) {
  const primary = primaryToken(event);
  if (!primary) return null;

  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  if (event.metaKey) parts.push("Win");
  parts.push(primary);
  return parts.join("+");
}

/** 生成界面显示文本，但不改变配置中使用的稳定 token。 */
export function shortcutDisplayLabel(shortcut) {
  return String(shortcut || "").split("+").filter(Boolean).join(" + ");
}
