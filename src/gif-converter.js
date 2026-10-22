import { decompressFrames, parseGIF } from "gifuct-js";
import {
  bitmapToSsd1306PageBuffer,
  createBlankBitmap,
  setBitmapPixel
} from "./oled-bitmap.js";
import { encodeVani, VANI_MAX_FRAMES } from "./animation-format.js";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_FRAMES = 2000;
const MAX_DURATION_MS = 60 * 1000;

function canvas(width, height) {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  return element;
}

function targetRect(sourceWidth, sourceHeight, fit) {
  const scale = fit === "cover"
    ? Math.max(128 / sourceWidth, 64 / sourceHeight)
    : Math.min(128 / sourceWidth, 64 / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  return {
    x:Math.floor((128 - width) / 2),
    y:Math.floor((64 - height) / 2),
    width,
    height
  };
}

/**
 * 返回二值化前应使用的画布背景色。
 * 反相处理发生在画布合成之后，因此这里需要预先使用相反颜色，
 * 确保最终 OLED 上的空白区域始终与用户选择一致。
 */
export function gifCanvasBackground(background, invert) {
  const finalBackgroundIsWhite = background === "white";
  const canvasBackgroundIsWhite = invert
    ? !finalBackgroundIsWhite
    : finalBackgroundIsWhite;
  return canvasBackgroundIsWhite ? "#ffffff" : "#000000";
}

function luminancePixels(imageData, invert, background) {
  const values = new Float32Array(128 * 64);
  const backgroundValue = gifCanvasBackground(background, invert) === "#ffffff" ? 255 : 0;
  for (let index = 0; index < values.length; index += 1) {
    const offset = index * 4;
    const alpha = imageData.data[offset + 3] / 255;
    let value = (
      imageData.data[offset] * 0.2126 +
      imageData.data[offset + 1] * 0.7152 +
      imageData.data[offset + 2] * 0.0722
    ) * alpha + backgroundValue * (1 - alpha);
    if (invert) value = 255 - value;
    values[index] = value;
  }
  return values;
}

function thresholdBitmap(values, threshold) {
  const bitmap = createBlankBitmap();
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      setBitmapPixel(bitmap, x, y, values[y * 128 + x] >= threshold);
    }
  }
  return bitmap;
}

function bayerBitmap(values, threshold) {
  const matrix = [
    [0, 8, 2, 10], [12, 4, 14, 6],
    [3, 11, 1, 9], [15, 7, 13, 5]
  ];
  const bitmap = createBlankBitmap();
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      const adjustment = (matrix[y & 3][x & 3] - 7.5) * 8;
      // 保留纯黑和纯白端点，避免高阈值时白色背景出现抖动杂点。
      const adjustedThreshold = Math.max(1, Math.min(254, threshold + adjustment));
      setBitmapPixel(bitmap, x, y, values[y * 128 + x] >= adjustedThreshold);
    }
  }
  return bitmap;
}

function floydSteinbergBitmap(values, threshold) {
  const work = Float32Array.from(values);
  const bitmap = createBlankBitmap();
  const add = (x, y, error, weight) => {
    if (x >= 0 && x < 128 && y >= 0 && y < 64) work[y * 128 + x] += error * weight;
  };
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      const index = y * 128 + x;
      const enabled = work[index] >= threshold;
      setBitmapPixel(bitmap, x, y, enabled);
      const error = work[index] - (enabled ? 255 : 0);
      add(x + 1, y, error, 7 / 16);
      add(x - 1, y + 1, error, 3 / 16);
      add(x, y + 1, error, 5 / 16);
      add(x + 1, y + 1, error, 1 / 16);
    }
  }
  return bitmap;
}

function imageDataToBitmap(imageData, options) {
  const values = luminancePixels(imageData, options.invert, options.background);
  let bitmap;
  if (options.dither === "bayer") bitmap = bayerBitmap(values, options.threshold);
  else if (options.dither === "floyd") bitmap = floydSteinbergBitmap(values, options.threshold);
  else bitmap = thresholdBitmap(values, options.threshold);

  // 完全透明处就是 GIF 的空白区域，强制写入目标背景色，避免抖动误差扩散出杂点。
  const backgroundPixelEnabled = options.background === "white";
  for (let index = 0; index < 128 * 64; index += 1) {
    if (imageData.data[index * 4 + 3] === 0) {
      setBitmapPixel(bitmap, index % 128, Math.floor(index / 128), backgroundPixelEnabled);
    }
  }
  return bitmap;
}

function limitFrameRate(frames, maximumFps) {
  const minimumDelay = Math.ceil(1000 / maximumFps);
  const selected = [];
  let accumulatedDelay = 0;
  for (const frame of frames) {
    accumulatedDelay += frame.delay;
    if (accumulatedDelay >= minimumDelay) {
      selected.push({ ...frame, delay:accumulatedDelay });
      accumulatedDelay = 0;
    }
  }
  if (accumulatedDelay > 0 && selected.length > 0) {
    selected[selected.length - 1].delay += accumulatedDelay;
  } else if (selected.length === 0 && frames.length > 0) {
    selected.push({ ...frames.at(-1), delay:Math.max(minimumDelay, accumulatedDelay) });
  }
  return selected;
}

/**
 * 将用户 GIF 完整合成、缩放、二值化并编码为 VANI。
 * GIF disposal 在源画布上处理，因此局部帧不会留下错误残影。
 */
export async function convertGifFile(file, userOptions = {}) {
  if (!file || !/\.gif$/i.test(file.name || "") || file.size > MAX_SOURCE_BYTES) {
    throw new Error("请选择不超过 20 MB 的 GIF 文件");
  }
  const options = {
    fit:userOptions.fit === "cover" ? "cover" : "contain",
    background:userOptions.background === "white" ? "white" : "black",
    dither:["threshold", "bayer", "floyd"].includes(userOptions.dither)
      ? userOptions.dither : "bayer",
    threshold:Math.max(32, Math.min(224, Number(userOptions.threshold) || 128)),
    invert:Boolean(userOptions.invert),
    maximumFps:Math.max(5, Math.min(15, Number(userOptions.maximumFps) || 10))
  };

  let gif;
  let frames;
  try {
    gif = parseGIF(await file.arrayBuffer());
    frames = decompressFrames(gif, true);
  } catch {
    throw new Error("GIF 文件无法解析或已经损坏");
  }
  if (!frames.length || frames.length > MAX_SOURCE_FRAMES) {
    throw new Error(`GIF 原始帧数必须为 1～${MAX_SOURCE_FRAMES}`);
  }
  const duration = frames.reduce((total, frame) => total + Math.max(20, frame.delay || 100), 0);
  if (duration > MAX_DURATION_MS) throw new Error("GIF 时长不能超过 60 秒");

  const sourceWidth = gif.lsd.width;
  const sourceHeight = gif.lsd.height;
  if (!sourceWidth || !sourceHeight || sourceWidth > 4096 || sourceHeight > 4096 ||
    sourceWidth * sourceHeight > 16 * 1024 * 1024) {
    throw new Error("GIF 画布尺寸过大，最大支持 4096×4096");
  }
  const sourceCanvas = canvas(sourceWidth, sourceHeight);
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently:true });
  const patchCanvas = canvas(sourceWidth, sourceHeight);
  const patchContext = patchCanvas.getContext("2d", { willReadFrequently:true });
  const outputCanvas = canvas(128, 64);
  const outputContext = outputCanvas.getContext("2d", { willReadFrequently:true });
  const placement = targetRect(sourceWidth, sourceHeight, options.fit);
  const converted = [];

  for (const frame of frames) {
    const saved = frame.disposalType === 3
      ? sourceContext.getImageData(0, 0, sourceWidth, sourceHeight)
      : null;
    patchContext.clearRect(0, 0, sourceWidth, sourceHeight);
    patchContext.putImageData(
      new ImageData(frame.patch, frame.dims.width, frame.dims.height),
      frame.dims.left,
      frame.dims.top
    );
    sourceContext.drawImage(patchCanvas, 0, 0);

    // 保留透明度，以便二值化后精确识别缩放留白和 GIF 自身的透明区域。
    outputContext.clearRect(0, 0, 128, 64);
    outputContext.imageSmoothingEnabled = true;
    outputContext.drawImage(
      sourceCanvas,
      placement.x,
      placement.y,
      placement.width,
      placement.height
    );
    const bitmap = imageDataToBitmap(
      outputContext.getImageData(0, 0, 128, 64),
      options
    );
    converted.push({ bitmap, delay:Math.max(20, frame.delay || 100) });

    if (frame.disposalType === 2) {
      sourceContext.clearRect(frame.dims.left, frame.dims.top, frame.dims.width, frame.dims.height);
    } else if (frame.disposalType === 3 && saved) {
      sourceContext.putImageData(saved, 0, 0);
    }
  }

  const limited = limitFrameRate(converted, options.maximumFps);
  if (limited.length > VANI_MAX_FRAMES) {
    throw new Error(`转换后仍有 ${limited.length} 帧，请缩短 GIF 或降低最大帧率`);
  }
  const pageFrames = limited.map(({ bitmap }) => bitmapToSsd1306PageBuffer(bitmap));
  const delays = limited.map(({ delay }) => delay);
  const vani = encodeVani(pageFrames, delays);
  return {
    vani,
    bitmaps:limited.map(({ bitmap }) => bitmap),
    delays,
    sourceWidth,
    sourceHeight,
    sourceFrames:frames.length,
    duration,
    options
  };
}
