export type ImageMetadata = {
  animated?: boolean;
  format: "gif" | "jpeg" | "png" | "webp";
  height: number;
  width: number;
};

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset] + (buffer[offset + 1] << 8) + (buffer[offset + 2] << 16);
}

function hasBytes(buffer: Buffer, offset: number, length: number): boolean {
  return offset >= 0 && length >= 0 && offset + length <= buffer.length;
}

function gifColorTableByteLength(packedByte: number): number {
  return 3 * 2 ** ((packedByte & 0x07) + 1);
}

function skipGifSubBlocks(buffer: Buffer, initialOffset: number): number | null {
  let offset = initialOffset;

  while (offset < buffer.length) {
    const length = buffer[offset];
    offset += 1;

    if (length === 0) {
      return offset;
    }

    if (!hasBytes(buffer, offset, length)) {
      return null;
    }
    offset += length;
  }

  return null;
}

function hasMultipleGifImages(buffer: Buffer): boolean {
  if (!hasBytes(buffer, 10, 3)) {
    return false;
  }

  const logicalScreenPackedByte = buffer[10];
  let offset = 13;
  if ((logicalScreenPackedByte & 0x80) !== 0) {
    const colorTableLength = gifColorTableByteLength(logicalScreenPackedByte);
    if (!hasBytes(buffer, offset, colorTableLength)) {
      return false;
    }
    offset += colorTableLength;
  }

  let imageDescriptors = 0;
  while (offset < buffer.length) {
    const marker = buffer[offset];
    offset += 1;

    if (marker === 0x3b) {
      return false;
    }

    if (marker === 0x21) {
      if (!hasBytes(buffer, offset, 1)) {
        return false;
      }
      offset += 1;
      const nextOffset = skipGifSubBlocks(buffer, offset);
      if (nextOffset === null) {
        return false;
      }
      offset = nextOffset;
      continue;
    }

    if (marker !== 0x2c) {
      return false;
    }

    imageDescriptors += 1;
    if (imageDescriptors > 1) {
      return true;
    }

    if (!hasBytes(buffer, offset, 9)) {
      return false;
    }
    const imagePackedByte = buffer[offset + 8];
    offset += 9;

    if ((imagePackedByte & 0x80) !== 0) {
      const colorTableLength = gifColorTableByteLength(imagePackedByte);
      if (!hasBytes(buffer, offset, colorTableLength)) {
        return false;
      }
      offset += colorTableLength;
    }

    if (!hasBytes(buffer, offset, 1)) {
      return false;
    }
    offset += 1;
    const nextOffset = skipGifSubBlocks(buffer, offset);
    if (nextOffset === null) {
      return false;
    }
    offset = nextOffset;
  }

  return false;
}

function unsupportedWebp(): never {
  throw new Error("webp_unsupported_format");
}

function unsupportedGif(): never {
  throw new Error("gif_unsupported_format");
}

export function extractImageMetadata(buffer: Buffer, mimeType: string): ImageMetadata {
  if (mimeType === "image/png") {
    if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("Invalid PNG signature");
    }

    return {
      format: "png",
      height: buffer.readUInt32BE(20),
      width: buffer.readUInt32BE(16)
    };
  }

  if (mimeType === "image/gif") {
    const header = buffer.subarray(0, 6).toString("ascii");

    if (header !== "GIF87a" && header !== "GIF89a") {
      throw new Error("Invalid GIF signature");
    }
    if (!hasBytes(buffer, 6, 7)) {
      return unsupportedGif();
    }

    return {
      animated: hasMultipleGifImages(buffer),
      format: "gif",
      height: buffer.readUInt16LE(8),
      width: buffer.readUInt16LE(6)
    };
  }

  if (mimeType === "image/webp") {
    if (buffer.subarray(0, 4).toString("ascii") !== "RIFF" || buffer.subarray(8, 12).toString("ascii") !== "WEBP") {
      throw new Error("Invalid WEBP signature");
    }

    if (!hasBytes(buffer, 12, 8)) {
      return unsupportedWebp();
    }

    const chunk = buffer.subarray(12, 16).toString("ascii");
    const chunkSize = buffer.readUInt32LE(16);
    const payloadOffset = 20;
    if (!hasBytes(buffer, payloadOffset, chunkSize)) {
      return unsupportedWebp();
    }

    if (chunk === "VP8 ") {
      if (
        chunkSize < 10 ||
        buffer[payloadOffset + 3] !== 0x9d ||
        buffer[payloadOffset + 4] !== 0x01 ||
        buffer[payloadOffset + 5] !== 0x2a
      ) {
        return unsupportedWebp();
      }

      return {
        format: "webp",
        height: buffer.readUInt16LE(payloadOffset + 8) & 0x3fff,
        width: buffer.readUInt16LE(payloadOffset + 6) & 0x3fff
      };
    }

    if (chunk === "VP8L") {
      if (chunkSize < 5 || buffer[payloadOffset] !== 0x2f) {
        return unsupportedWebp();
      }

      const dimensions = buffer.readUInt32LE(payloadOffset + 1);
      return {
        format: "webp",
        height: ((dimensions >>> 14) & 0x3fff) + 1,
        width: (dimensions & 0x3fff) + 1
      };
    }

    if (chunk === "VP8X") {
      if (chunkSize < 10) {
        return unsupportedWebp();
      }

      return {
        format: "webp",
        height: readUInt24LE(buffer, payloadOffset + 7) + 1,
        width: readUInt24LE(buffer, payloadOffset + 4) + 1
      };
    }

    return unsupportedWebp();
  }

  if (mimeType === "image/jpeg") {
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
      throw new Error("Invalid JPEG signature");
    }

    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);

      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          format: "jpeg",
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7)
        };
      }

      offset += 2 + length;
    }
  }

  throw new Error("Unsupported image metadata");
}
