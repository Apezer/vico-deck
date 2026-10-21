import { animationCrc32, VANI_MAX_BYTES } from "./animation-format.js";

export const ANIMATION_COMMAND = Object.freeze({
  BEGIN:0x50,
  CHUNK:0x51,
  COMMIT:0x52,
  DELETE:0x53,
  CANCEL:0x54
});

export const ANIMATION_CHUNK_BYTES = 56;

export const ANIMATION_ERRORS = Object.freeze([
  "成功",
  "动画文件大小无效",
  "键盘正在接收另一个动画",
  "SPIFFS 写入失败",
  "动画分片顺序不正确",
  "动画 CRC 校验失败",
  "动画文件格式无效",
  "没有进行中的动画上传",
  "SPIFFS 可用空间不足"
]);

export function uint32Bytes(value) {
  const safe = Number(value) >>> 0;
  return [safe & 0xff, (safe >>> 8) & 0xff, (safe >>> 16) & 0xff, (safe >>> 24) & 0xff];
}

export function validateAnimationForUpload(bytes, maximumBytes = VANI_MAX_BYTES) {
  const source = Uint8Array.from(bytes || []);
  if (!source.length || source.length > maximumBytes) {
    throw new Error(`动画文件不能超过 ${Math.floor(maximumBytes / 1024)} KiB`);
  }
  return { bytes:source, crc:animationCrc32(source) };
}
