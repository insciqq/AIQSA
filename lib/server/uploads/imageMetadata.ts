export type ImageMetadata = {
  animated?: boolean;
  format: "gif" | "jpeg" | "png" | "webp";
  height: number;
  width: number;
};

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset] + (buffer[offset + 1] << 8) + (buffer[offset + 2] << 16);
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

    let imageDescriptors = 0;
    for (let index = 13; index < buffer.length; index += 1) {
      if (buffer[index] === 0x2c) {
        imageDescriptors += 1;
      }
    }

    return {
      animated: imageDescriptors > 1,
      format: "gif",
      height: buffer.readUInt16LE(8),
      width: buffer.readUInt16LE(6)
    };
  }

  if (mimeType === "image/webp") {
    if (buffer.subarray(0, 4).toString("ascii") !== "RIFF" || buffer.subarray(8, 12).toString("ascii") !== "WEBP") {
      throw new Error("Invalid WEBP signature");
    }

    const chunk = buffer.subarray(12, 16).toString("ascii");

    if (chunk === "VP8X") {
      return {
        format: "webp",
        height: readUInt24LE(buffer, 27) + 1,
        width: readUInt24LE(buffer, 24) + 1
      };
    }

    throw new Error("Unsupported WEBP header");
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
