import assert from "node:assert/strict";
import sharp from "sharp";

// Independently reviewed raster for V4K8M2, in reading order. Check the actual
// decoded attachment, including every white pixel and each character gap;
// table borders, a nonempty image, or a different code cannot satisfy this.
const codeRows = [
  "10001 00010 10001 01110 10001 01110",
  "10001 00110 10010 10001 11011 10001",
  "10001 01010 10100 10001 10101 00001",
  "10001 10010 11000 01110 10101 00010",
  "10001 11111 10100 10001 10001 00100",
  "01010 00010 10010 10001 10001 01000",
  "00100 00010 10001 01110 10001 11111"
];

export async function assertVisionProbeImage(image: Buffer): Promise<void> {
  const metadata = await sharp(image).metadata();
  assert.equal(metadata.format, "png", "vision_probe_format_invalid");
  assert.equal(metadata.width, 640, "vision_probe_width_invalid");
  assert.equal(metadata.height, 240, "vision_probe_height_invalid");
  const pixels = await sharp(image)
    .extract({ left: 345, top: 145, width: 216, height: 42 })
    .flatten({ background: "#ffffff" }).greyscale().raw().toBuffer();
  for (let y = 0; y < 42; y += 1) {
    const row = `${codeRows[Math.floor(y / 6)].replaceAll(" ", "0")}0`;
    for (let x = 0; x < 216; x += 1) {
      if (pixels[y * 216 + x] !== (row[Math.floor(x / 6)] === "1" ? 0 : 255)) {
        throw new Error("vision_probe_code_pixels_invalid");
      }
    }
  }
}
