export const VICO_HID_REPORT_ID = 6;
export const VICO_HID_REPORT_BYTES = 63;
export const VICO_HID_MAX_PAYLOAD = 60;
export const OLED_TWIN_FRAME_BYTES = 128 * 64 / 8;

export const TWIN_COMMAND = Object.freeze({
  HELLO: 0x01,
  DISPLAY_SUBSCRIBE: 0x02,
  HELLO_ACK: 0x81,
  FRAME_BEGIN: 0x82,
  FRAME_CHUNK: 0x83,
  FRAME_END: 0x84
});

function readUint16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function xorChecksum(bytes) {
  let checksum = 0;
  for (let index = 0; index < VICO_HID_REPORT_BYTES - 1; index += 1) {
    checksum ^= bytes[index];
  }
  return checksum;
}

/** Build one fixed-size Vendor HID report (the report ID is sent separately). */
export function buildHidReport(command, payload = []) {
  if (payload.length > VICO_HID_MAX_PAYLOAD) {
    throw new Error(`HID payload exceeds ${VICO_HID_MAX_PAYLOAD} bytes`);
  }

  const report = new Uint8Array(VICO_HID_REPORT_BYTES);
  report[0] = command;
  report[1] = payload.length;
  report.set(payload, 2);
  report[VICO_HID_REPORT_BYTES - 1] = xorChecksum(report);
  return report;
}

/** Validate and split a fixed-size report without exposing mutable backing data. */
export function parseHidReport(value) {
  const bytes = value instanceof Uint8Array
    ? value
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

  if (bytes.byteLength !== VICO_HID_REPORT_BYTES) return null;
  if (bytes[1] > VICO_HID_MAX_PAYLOAD) return null;
  if (bytes[VICO_HID_REPORT_BYTES - 1] !== xorChecksum(bytes)) return null;

  return {
    command: bytes[0],
    payload: Uint8Array.from(bytes.slice(2, 2 + bytes[1]))
  };
}

/** Standard CRC32 used to reject incomplete or mixed OLED frames. */
export function calculateCrc32(bytes) {
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
 * Reassembles frame reports. A frame is published only after every byte and
 * both CRC values have been verified, so React never renders a partial frame.
 */
export class OledTwinReceiver {
  constructor() {
    this.reset();
  }

  reset() {
    this.frame = null;
  }

  accept(parsedReport) {
    if (!parsedReport) return null;
    const { command, payload } = parsedReport;

    if (command === TWIN_COMMAND.FRAME_BEGIN) {
      if (payload.length < 9) return null;
      const length = readUint16(payload, 2);
      if (length !== OLED_TWIN_FRAME_BYTES) return null;

      this.frame = {
        sequence: readUint16(payload, 0),
        expectedCrc: readUint32(payload, 4),
        format: payload[8],
        bytes: new Uint8Array(length),
        received: new Uint8Array(length),
        receivedCount: 0
      };
      return null;
    }

    if (command === TWIN_COMMAND.FRAME_CHUNK) {
      if (!this.frame || payload.length < 5) return null;
      const sequence = readUint16(payload, 0);
      const offset = readUint16(payload, 2);
      const chunk = payload.slice(4);
      if (sequence !== this.frame.sequence || offset + chunk.length > this.frame.bytes.length) {
        this.reset();
        return null;
      }

      this.frame.bytes.set(chunk, offset);
      for (let index = 0; index < chunk.length; index += 1) {
        const target = offset + index;
        if (!this.frame.received[target]) {
          this.frame.received[target] = 1;
          this.frame.receivedCount += 1;
        }
      }
      return null;
    }

    if (command === TWIN_COMMAND.FRAME_END) {
      if (!this.frame || payload.length < 6) return null;
      const sequence = readUint16(payload, 0);
      const endCrc = readUint32(payload, 2);
      const actualCrc = calculateCrc32(this.frame.bytes);
      const complete = this.frame.receivedCount === this.frame.bytes.length;
      const valid = sequence === this.frame.sequence
        && complete
        && endCrc === this.frame.expectedCrc
        && actualCrc === this.frame.expectedCrc;

      const completed = valid ? {
        sequence: this.frame.sequence,
        format: this.frame.format,
        crc32: actualCrc,
        bytes: Uint8Array.from(this.frame.bytes)
      } : null;
      this.reset();
      return completed;
    }

    return null;
  }
}
