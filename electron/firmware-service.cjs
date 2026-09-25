const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_REMOTE_CATALOG = "https://update.zheng2005.xyz/firmware/catalog.json";
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const CATALOG_TIMEOUT_MS = 4000;
const IMAGE_TIMEOUT_MS = 30000;
const FLASH_MODES = new Set(["keep", "dio", "qio", "dout", "qout"]);
const FLASH_FREQUENCIES = new Set(["keep", "80m", "60m", "48m", "40m", "30m", "26m", "24m", "20m", "16m", "15m", "12m"]);
const FLASH_SIZES = new Set(["detect", "keep", "2MB", "4MB", "8MB", "16MB", "32MB"]);
const LOCAL_IMAGE_LAYOUT = Object.freeze([
  { role:"bootloader", file:"bootloader.bin", address:0x0000 },
  { role:"partitions", file:"partitions.bin", address:0x8000 },
  { role:"boot_app0", file:"boot_app0.bin", address:0xe000 },
  { role:"application", file:"firmware.bin", address:0x10000 }
]);
const WRITE_MODES = new Set(["quick", "full"]);

function normalizeWriteMode(value) {
  const mode = value || "full";
  if (!WRITE_MODES.has(mode)) throw new Error("固件烧录方式无效");
  return mode;
}

function selectImagesForMode(images, mode) {
  if (mode === "full") {
    return LOCAL_IMAGE_LAYOUT.map((required) => {
      const image = images.find((item) => item.role === required.role || item.address === required.address);
      if (!image || image.address !== required.address) {
        throw new Error(`该固件缺少完整烧录所需的 ${required.file}`);
      }
      return image;
    });
  }
  const application = images.find((image) => image.role === "application" || image.address === 0x10000);
  if (!application || application.address !== 0x10000) {
    throw new Error("该固件没有可用于快速升级的 firmware.bin");
  }
  return [application];
}

function readSelectedBin(filePath) {
  if (typeof filePath !== "string" || path.extname(filePath).toLowerCase() !== ".bin") {
    throw new Error("请选择有效的 BIN 固件文件");
  }
  const resolvedPath = path.resolve(filePath);
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
    throw new Error("所选 BIN 固件文件大小无效");
  }
  return { resolvedPath, bytes:fs.readFileSync(resolvedPath) };
}

function verifyEspImageDigest(bytes, label = "ESP 镜像") {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes[0] !== 0xe9) {
    throw new Error(`${label} 不是有效的 ESP 固件镜像`);
  }

  const segmentCount = bytes[1];
  if (segmentCount < 1 || segmentCount > 16) {
    throw new Error(`${label} 的段数量无效`);
  }

  let offset = 24;
  for (let index = 0; index < segmentCount; index += 1) {
    if (offset + 8 > bytes.length) throw new Error(`${label} 的段头不完整`);
    const dataLength = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (dataLength > bytes.length - offset) throw new Error(`${label} 的段数据不完整`);
    offset += dataLength;
  }

  // 所有段之后包含一字节校验和，并补齐到 16 字节边界；随后才是 SHA-256。
  const imageDataLength = (offset + 1 + 15) & ~15;
  const shaAppended = bytes[23] === 1;
  if (!shaAppended) return { shaAppended:false, imageDataLength };
  if (imageDataLength + 32 > bytes.length) throw new Error(`${label} 缺少 SHA-256 摘要`);

  const stored = bytes.subarray(imageDataLength, imageDataLength + 32);
  const calculated = crypto.createHash("sha256").update(bytes.subarray(0, imageDataLength)).digest();
  if (!crypto.timingSafeEqual(stored, calculated)) {
    throw new Error(`${label} 的内部 SHA-256 校验失败`);
  }
  return { shaAppended:true, imageDataLength };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCatalog(value) {
  if (!isPlainObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.releases)) {
    throw new Error("固件目录格式无效");
  }

  const releases = value.releases.map((release) => {
    if (!isPlainObject(release) || !/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(release.id || "") ||
        !/^\d+\.\d+\.\d+$/.test(release.version || "")) {
      throw new Error("固件版本号格式无效");
    }
    if (!Array.isArray(release.images) || release.images.length === 0 || release.images.length > 8) {
      throw new Error(`固件 ${release.version} 缺少烧录镜像`);
    }

    const images = release.images.map((image) => {
      const address = Number(image?.address);
      const size = Number(image?.size);
      if (!isPlainObject(image) || !/^[a-z0-9_-]+$/i.test(image.role || "") ||
          !/^[a-f0-9]{64}$/i.test(image.sha256 || "") ||
          !Number.isSafeInteger(address) || address < 0 || address > 0x1000000 ||
          !Number.isSafeInteger(size) || size <= 0 || size > MAX_IMAGE_BYTES) {
        throw new Error(`固件 ${release.version} 的镜像信息无效`);
      }
      if (typeof image.file !== "string" && typeof image.url !== "string") {
        throw new Error(`固件 ${release.version} 的镜像地址无效`);
      }
      if (image.url && !/^https:\/\//i.test(image.url)) {
        throw new Error("远程固件镜像必须使用 HTTPS");
      }
      return {
        role:image.role,
        file:typeof image.file === "string" ? image.file : undefined,
        url:typeof image.url === "string" ? image.url : undefined,
        address,
        size,
        sha256:image.sha256.toLowerCase()
      };
    });

    const target = isPlainObject(release.target) ? release.target : {};
    const flashMode = String(target.flashMode || "keep");
    const flashFrequency = String(target.flashFrequency || "keep");
    const flashSize = String(target.flashSize || "4MB");
    if (!FLASH_MODES.has(flashMode) || !FLASH_FREQUENCIES.has(flashFrequency) || !FLASH_SIZES.has(flashSize)) {
      throw new Error(`固件 ${release.version} 的 Flash 参数无效`);
    }
    return {
      id:release.id,
      version:release.version,
      category:String(release.category || "keyboard").slice(0, 32),
      channel:release.channel === "beta" ? "beta" : "stable",
      title:String(release.title || `Vico Keyboard ${release.version}`).slice(0, 100),
      publishedAt:String(release.publishedAt || "").slice(0, 32),
      description:String(release.description || "").slice(0, 500),
      notes:Array.isArray(release.notes) ? release.notes.slice(0, 12).map((note) => String(note).slice(0, 200)) : [],
      target:{
        chip:String(target.chip || "ESP32-S3"),
        flashSize,
        flashMode,
        flashFrequency
      },
      images
    };
  });

  if (new Set(releases.map((release) => release.id)).size !== releases.length) {
    throw new Error("固件目录包含重复 ID");
  }

  releases.sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric:true }));
  return {
    schemaVersion:1,
    device:String(value.device || "Vico Keyboard"),
    board:String(value.board || "ESP32-S3"),
    generatedAt:String(value.generatedAt || ""),
    releases
  };
}

function safeLocalPath(root, relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
    throw new Error("本地固件路径无效");
  }
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relativePath);
  const insideRoot = candidate === resolvedRoot || candidate.startsWith(`${resolvedRoot}${path.sep}`);
  if (!insideRoot) throw new Error("固件路径超出允许目录");
  return candidate;
}

function readLocalImage(folderPath, fileName, role) {
  const entries = fs.readdirSync(folderPath, { withFileTypes:true });
  const entry = entries.find((item) => item.isFile() && item.name.toLowerCase() === fileName.toLowerCase());
  if (!entry) throw new Error(`所选文件夹缺少 ${fileName}`);

  const imagePath = safeLocalPath(folderPath, entry.name);
  const stat = fs.statSync(imagePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`本地固件镜像 ${role} 大小无效`);
  }
  return fs.readFileSync(imagePath);
}

function serializeImage(role, address, bytes) {
  if (role === "bootloader" || role === "application") {
    verifyEspImageDigest(bytes, `固件镜像 ${role}`);
  }
  return {
    role,
    address,
    size:bytes.length,
    sha256:crypto.createHash("sha256").update(bytes).digest("hex"),
    data:bytes.toString("base64")
  };
}

async function fetchBytes(url, { timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal:controller.signal, cache:"no-store" });
    if (!response.ok) throw new Error(`服务器返回 HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > maxBytes) throw new Error("服务器文件超过大小限制");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maxBytes) throw new Error("服务器文件大小无效");
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

class FirmwareService {
  constructor({
    localRoot = path.join(__dirname, "..", "firmware"),
    remoteCatalogUrl = DEFAULT_REMOTE_CATALOG
  } = {}) {
    this.localRoot = localRoot;
    this.remoteCatalogUrl = remoteCatalogUrl;
    this.catalogRecord = null;
  }

  loadLocalCatalog() {
    const catalogPath = safeLocalPath(this.localRoot, "catalog.json");
    const bytes = fs.readFileSync(catalogPath);
    if (bytes.length > MAX_CATALOG_BYTES) throw new Error("内置固件目录过大");
    return { catalog:normalizeCatalog(JSON.parse(bytes.toString("utf8"))), source:"bundled" };
  }

  async loadRemoteCatalog() {
    if (!this.remoteCatalogUrl) throw new Error("未配置远程固件目录");
    const bytes = await fetchBytes(this.remoteCatalogUrl, {
      timeoutMs:CATALOG_TIMEOUT_MS,
      maxBytes:MAX_CATALOG_BYTES
    });
    return { catalog:normalizeCatalog(JSON.parse(bytes.toString("utf8"))), source:"server" };
  }

  async loadCatalog(refresh = false) {
    if (!refresh && this.catalogRecord) return this.catalogRecord;
    try {
      this.catalogRecord = await this.loadRemoteCatalog();
    } catch {
      this.catalogRecord = this.loadLocalCatalog();
    }
    return this.catalogRecord;
  }

  async getCatalog(refresh = false) {
    const record = await this.loadCatalog(refresh);
    return { ...record.catalog, source:record.source };
  }

  async readImage(image, source) {
    if (source === "server") {
      const url = image.url || new URL(image.file, this.remoteCatalogUrl).toString();
      return fetchBytes(url, { timeoutMs:IMAGE_TIMEOUT_MS, maxBytes:MAX_IMAGE_BYTES });
    }
    const imagePath = safeLocalPath(this.localRoot, image.file);
    const stat = fs.statSync(imagePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
      throw new Error(`固件镜像 ${image.role} 大小无效`);
    }
    return fs.readFileSync(imagePath);
  }

  async getBundle(releaseId, requestedMode) {
    const writeMode = requestedMode === undefined ? "catalog" : normalizeWriteMode(requestedMode);
    if (typeof releaseId !== "string" || !/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(releaseId)) {
      throw new Error("请选择有效的固件");
    }
    const record = await this.loadCatalog(false);
    const release = record.catalog.releases.find((item) => item.id === releaseId);
    if (!release) throw new Error(`没有找到固件 ${releaseId}`);

    const images = [];
    const selectedImages = writeMode === "catalog" ? release.images : selectImagesForMode(release.images, writeMode);
    for (const image of selectedImages) {
      const bytes = await this.readImage(image, record.source);
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== image.size || sha256 !== image.sha256) {
        throw new Error(`固件镜像 ${image.role} 校验失败，已停止烧录`);
      }
      images.push(serializeImage(image.role, image.address, bytes));
    }

    return {
      id:release.id,
      version:release.version,
      writeMode,
      target:release.target,
      source:record.source,
      totalSize:images.reduce((total, image) => total + image.size, 0),
      images
    };
  }

  getLocalBundle(sourcePath, requestedMode = "full") {
    const writeMode = normalizeWriteMode(requestedMode);
    if (writeMode === "quick") {
      const { resolvedPath, bytes } = readSelectedBin(sourcePath);
      const image = serializeImage("application", 0x10000, bytes);
      return {
        id:"local-bin-file",
        version:"本地",
        writeMode,
        title:path.basename(resolvedPath),
        sourcePath:resolvedPath,
        description:"从本机选择的应用固件，只写入键盘主程序区域。",
        notes:[`${path.basename(resolvedPath)} → 0x10000`],
        target:{ chip:"ESP32-S3", flashSize:"keep", flashMode:"keep", flashFrequency:"keep" },
        source:"local",
        totalSize:image.size,
        images:[image]
      };
    }

    if (typeof sourcePath !== "string" || !sourcePath.trim()) {
      throw new Error("请选择包含固件镜像的文件夹");
    }
    const resolvedFolder = path.resolve(sourcePath);
    const stat = fs.statSync(resolvedFolder);
    if (!stat.isDirectory()) throw new Error("所选路径不是文件夹");

    const selectedLayout = selectImagesForMode(LOCAL_IMAGE_LAYOUT, writeMode);
    const images = selectedLayout.map((image) => serializeImage(
      image.role,
      image.address,
      readLocalImage(resolvedFolder, image.file, image.role)
    ));
    return {
      id:"local-bin-folder",
      version:"本地",
      writeMode,
      title:path.basename(resolvedFolder),
      sourcePath:resolvedFolder,
      description:"从本机文件夹读取的 ESP32-S3 完整分段固件。",
      notes:selectedLayout.map((image) => `${image.file} → 0x${image.address.toString(16).toUpperCase()}`),
      target:{ chip:"ESP32-S3", flashSize:"keep", flashMode:"keep", flashFrequency:"keep" },
      source:"local",
      totalSize:images.reduce((total, image) => total + image.size, 0),
      images
    };
  }
}

module.exports = {
  FirmwareService,
  LOCAL_IMAGE_LAYOUT,
  normalizeWriteMode,
  normalizeCatalog,
  safeLocalPath,
  verifyEspImageDigest
};
