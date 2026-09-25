const assert = require("node:assert/strict");
const { parseUsbId, isVicoFirmwarePort } = require("../electron/usb-device.cjs");

assert.equal(parseUsbId(0x303a), 0x303a);
assert.equal(parseUsbId("12346"), 0x303a);
assert.equal(parseUsbId("0x303A"), 0x303a);
assert.equal(parseUsbId("303A"), 0x303a);
assert.equal(parseUsbId("4097"), 0x1001);
assert.equal(parseUsbId("not-an-id"), 0);

assert.equal(isVicoFirmwarePort({ vendorId:"12346", productId:"4097" }), true);
assert.equal(isVicoFirmwarePort({ vendorId:"13123", productId:"33743" }), true);
assert.equal(isVicoFirmwarePort({ vendorId:"4660", productId:"1" }), false);

console.log("USB device ID tests passed: Electron decimal serial IDs are accepted");
