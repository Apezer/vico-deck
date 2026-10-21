import { OLED_BITMAP_BYTES, ssd1306PageBufferToBitmap } from "./oled-bitmap.js";

export const VANI_VERSION = 1;
export const VANI_HEADER_BYTES = 24;
export const VANI_FRAME_HEADER_BYTES = 6;
// 固件采用 A/B 双槽原子更新。默认 1408 KiB SPIFFS 下，每槽限制 480 KiB。
export const VANI_MAX_BYTES = 480 * 1024;
export const VANI_MAX_FRAMES = 600;
export const VANI_ENCODING_RAW = 0;
export const VANI_ENCODING_XOR_RLE = 1;

function writeUint16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

/** 与固件和 USB 上传协议一致的标准 CRC32。 */
export function animationCrc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (~crc) >>> 0;
}

/**
 * 压缩相邻帧的 XOR 差异。高位为 1 的控制字表示连续零，
 * 高位为 0 表示后面跟随 1～128 个原样差异字节。
 */
export function encodeXorRle(previous, current) {
  const output = [];
  let offset = 0;
  while (offset < OLED_BITMAP_BYTES) {
    const difference = previous[offset] ^ current[offset];
    if (difference === 0) {
      let count = 1;
      while (count < 128 && offset + count < OLED_BITMAP_BYTES &&
        (previous[offset + count] ^ current[offset + count]) === 0) count += 1;
      output.push(0x80 | (count - 1));
      offset += count;
      continue;
    }

    const literalStart = offset;
    let count = 1;
    while (count < 128 && literalStart + count < OLED_BITMAP_BYTES &&
      (previous[literalStart + count] ^ current[literalStart + count]) !== 0) count += 1;
    output.push(count - 1);
    for (let index = 0; index < count; index += 1) {
      output.push(previous[literalStart + index] ^ current[literalStart + index]);
    }
    offset += count;
  }
  return Uint8Array.from(output);
}

function decodeXorRle(previous, encoded) {
  const frame = Uint8Array.from(previous);
  let inputOffset = 0;
  let outputOffset = 0;
  while (inputOffset < encoded.length && outputOffset < OLED_BITMAP_BYTES) {
    const control = encoded[inputOffset++];
    const count = (control & 0x7f) + 1;
    if (outputOffset + count > OLED_BITMAP_BYTES) throw new Error("动画差分数据越界");
    if (control & 0x80) {
      outputOffset += count;
      continue;
    }
    if (inputOffset + count > encoded.length) throw new Error("动画差分数据不完整");
    for (let index = 0; index < count; index += 1) {
      frame[outputOffset++] ^= encoded[inputOffset++];
    }
  }
  if (inputOffset !== encoded.length || outputOffset !== OLED_BITMAP_BYTES) {
    throw new Error("动画差分帧长度无效");
  }
  return frame;
}

/** 将一组 SSD1306 页优先帧打包为固件可以直接播放的 VANI 文件。 */
export function encodeVani(pageFrames, delays) {
  if (!Array.isArray(pageFrames) || pageFrames.length === 0 || pageFrames.length > VANI_MAX_FRAMES) {
    throw new Error(`动画帧数必须为 1～${VANI_MAX_FRAMES}`);
  }
  if (!Array.isArray(delays) || delays.length !== pageFrames.length) {
    throw new Error("每一帧都必须提供显示时间");
  }

  const records = pageFrames.map((source, index) => {
    const frame = Uint8Array.from(source || []);
    if (frame.length !== OLED_BITMAP_BYTES) throw new Error("动画帧必须为 128×64 1-bit");
    const delay = Math.max(20, Math.min(5000, Math.round(Number(delays[index]) || 100)));
    if (index === 0) return { delay, encoding:VANI_ENCODING_RAW, data:frame };
    const compressed = encodeXorRle(pageFrames[index - 1], frame);
    return compressed.length < frame.length
      ? { delay, encoding:VANI_ENCODING_XOR_RLE, data:compressed }
      : { delay, encoding:VANI_ENCODING_RAW, data:frame };
  });

  const totalDuration = records.reduce((total, record) => total + record.delay, 0);
  const fileBytes = VANI_HEADER_BYTES + records.reduce(
    (total, record) => total + VANI_FRAME_HEADER_BYTES + record.data.length,
    0
  );
  if (fileBytes > VANI_MAX_BYTES) {
    throw new Error(`动画转换后为 ${Math.ceil(fileBytes / 1024)} KiB，超过 480 KiB 限制`);
  }

  const output = new Uint8Array(fileBytes);
  const view = new DataView(output.buffer);
  output.set([0x56, 0x41, 0x4e, 0x49], 0); // VANI
  output[4] = VANI_VERSION;
  output[5] = 128;
  output[6] = 64;
  output[7] = 1; // 第一版统一循环播放，固件据此拒绝不兼容的非循环文件。
  writeUint16(view, 8, records.length);
  writeUint16(view, 10, VANI_HEADER_BYTES);
  writeUint32(view, 12, fileBytes);
  writeUint32(view, 16, totalDuration);
  writeUint32(view, 20, 0);

  let offset = VANI_HEADER_BYTES;
  for (const record of records) {
    writeUint16(view, offset, record.delay);
    output[offset + 2] = record.encoding;
    output[offset + 3] = 0;
    writeUint16(view, offset + 4, record.data.length);
    output.set(record.data, offset + VANI_FRAME_HEADER_BYTES);
    offset += VANI_FRAME_HEADER_BYTES + record.data.length;
  }
  return output;
}

/** 解析 VANI，供软件重启后的缓存预览和单元测试使用。 */
export function decodeVani(bytes) {
  const source = Uint8Array.from(bytes || []);
  if (source.length < VANI_HEADER_BYTES ||
    String.fromCharCode(...source.slice(0, 4)) !== "VANI" ||
    source[4] !== VANI_VERSION || source[5] !== 128 || source[6] !== 64) {
    throw new Error("不是有效的 Vico OLED 动画文件");
  }
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const frameCount = view.getUint16(8, true);
  const headerBytes = view.getUint16(10, true);
  const fileBytes = view.getUint32(12, true);
  if (!frameCount || frameCount > VANI_MAX_FRAMES || headerBytes !== VANI_HEADER_BYTES || fileBytes !== source.length) {
    throw new Error("Vico OLED 动画文件头无效");
  }

  const pageFrames = [];
  const bitmaps = [];
  const delays = [];
  let offset = headerBytes;
  let previous = new Uint8Array(OLED_BITMAP_BYTES);
  for (let index = 0; index < frameCount; index += 1) {
    if (offset + VANI_FRAME_HEADER_BYTES > source.length) throw new Error("动画帧头不完整");
    const delay = view.getUint16(offset, true);
    const encoding = source[offset + 2];
    const length = view.getUint16(offset + 4, true);
    offset += VANI_FRAME_HEADER_BYTES;
    if (offset + length > source.length) throw new Error("动画帧数据不完整");
    const encoded = source.slice(offset, offset + length);
    offset += length;

    let frame;
    if (encoding === VANI_ENCODING_RAW && length === OLED_BITMAP_BYTES) {
      frame = encoded;
    } else if (encoding === VANI_ENCODING_XOR_RLE && index > 0) {
      frame = decodeXorRle(previous, encoded);
    } else {
      throw new Error("动画帧编码不受支持");
    }
    previous = Uint8Array.from(frame);
    pageFrames.push(previous);
    bitmaps.push(ssd1306PageBufferToBitmap(previous));
    delays.push(delay);
  }
  if (offset !== source.length) throw new Error("动画文件包含多余数据");
  return { pageFrames, bitmaps, delays, loop:Boolean(source[7] & 1), crc:animationCrc32(source) };
}

