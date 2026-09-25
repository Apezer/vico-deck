const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FirmwareService,
  LOCAL_IMAGE_LAYOUT,
  normalizeWriteMode,
  normalizeCatalog,
  safeLocalPath,
  verifyEspImageDigest
} = require("../electron/firmware-service.cjs");

async function run() {
  const localRoot = path.join(__dirname, "..", "firmware");
  const service = new FirmwareService({ localRoot, remoteCatalogUrl:null });
  const catalog = await service.getCatalog();

  assert.equal(catalog.source, "bundled");
  assert.equal(catalog.device, "Vico Keyboard");
  assert.equal(catalog.releases[0].version, "1.0.0");
  assert.equal(catalog.releases[0].id, "vico-keyboard-standard-1.0.0");
  assert.equal(catalog.releases[0].target.chip, "ESP32-S3");
  assert.equal(catalog.releases[0].target.flashMode, "keep");
  assert.equal(catalog.releases[0].target.flashFrequency, "keep");
  assert.equal(catalog.releases[0].target.flashSize, "keep");
  assert.equal(catalog.releases[0].images.length, 4);

  const bundle = await service.getBundle("vico-keyboard-standard-1.0.0");
  assert.equal(bundle.version, "1.0.0");
  assert.equal(bundle.images[0].address, 0x0000);
  assert.equal(bundle.images.at(-1).address, 0x10000);
  assert.ok(bundle.totalSize > 750000);
  assert.ok(bundle.images.every((image) => Buffer.from(image.data, "base64").length === image.size));

  const quickBundle = await service.getBundle("vico-keyboard-standard-1.0.0", "quick");
  assert.equal(quickBundle.writeMode, "quick");
  assert.equal(quickBundle.images.length, 1);
  assert.equal(quickBundle.images[0].role, "application");
  assert.equal(quickBundle.images[0].address, 0x10000);

  const bootloader = Buffer.from(bundle.images[0].data, "base64");
  assert.equal(verifyEspImageDigest(bootloader, "测试 bootloader").shaAppended, true);
  const damagedBootloader = Buffer.from(bootloader);
  damagedBootloader[2] ^= 0x02;
  assert.throws(() => verifyEspImageDigest(damagedBootloader, "损坏的 bootloader"), /内部 SHA-256 校验失败/);

  assert.throws(() => safeLocalPath(localRoot, "../package.json"), /超出允许目录/);
  assert.throws(() => normalizeCatalog({ schemaVersion:1, releases:[{ id:"bad-release", version:"bad", images:[] }] }), /版本号/);

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "vico-local-firmware-"));
  try {
    for (const image of LOCAL_IMAGE_LAYOUT) {
      fs.copyFileSync(path.join(localRoot, "1.0.0", image.file), path.join(tempDirectory, image.file));
    }
    const localBundle = service.getLocalBundle(tempDirectory);
    assert.equal(localBundle.source, "local");
    assert.equal(localBundle.images.length, 4);
    assert.equal(localBundle.images[0].address, 0x0000);
    assert.equal(localBundle.images.at(-1).address, 0x10000);
    assert.equal(localBundle.target.flashMode, "keep");

    const localQuickBundle = service.getLocalBundle(path.join(tempDirectory, "firmware.bin"), "quick");
    assert.equal(localQuickBundle.writeMode, "quick");
    assert.equal(localQuickBundle.images.length, 1);
    assert.equal(localQuickBundle.images[0].role, "application");
    assert.equal(localQuickBundle.images[0].address, 0x10000);
    assert.equal(localQuickBundle.sourcePath, path.join(tempDirectory, "firmware.bin"));
  } finally {
    fs.rmSync(tempDirectory, { recursive:true, force:true });
  }
  assert.equal(normalizeWriteMode(undefined), "full");
  assert.throws(() => normalizeWriteMode("dangerous"), /烧录方式无效/);
  console.log("firmware-service tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
