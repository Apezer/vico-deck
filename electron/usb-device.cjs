const ESPRESSIF_USB_VENDOR_ID = 0x303a;
const VICO_USB_VENDOR_ID = 0x3343;

/**
 * Electron 的 HID 设备通常返回数字 VID/PID，而 Windows SerialPort 返回十进制
 * 字符串。这里同时接受数字、十进制字符串、0x 前缀和包含 A-F 的十六进制字符串。
 */
function parseUsbId(value) {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (/^0x[0-9a-f]+$/i.test(normalized)) return Number.parseInt(normalized.slice(2), 16) || 0;
    if (/^[0-9]+$/.test(normalized)) return Number.parseInt(normalized, 10) || 0;
    if (/^[0-9a-f]+$/i.test(normalized)) return Number.parseInt(normalized, 16) || 0;
    return 0;
  }
  return Number(value || 0);
}

function isVicoFirmwarePort(device) {
  const vendorId = parseUsbId(device?.vendorId);
  return vendorId === ESPRESSIF_USB_VENDOR_ID || vendorId === VICO_USB_VENDOR_ID;
}

module.exports = {
  ESPRESSIF_USB_VENDOR_ID,
  VICO_USB_VENDOR_ID,
  parseUsbId,
  isVicoFirmwarePort
};
