import assert from "node:assert/strict";
import sharp from "sharp";

// Independently reviewed PEARS lettering and its quantity 7. Check decoded
// attachment pixels, including white space: a blank or different receipt fails.
const answerRows = [
  "11110 11111 01110 11110 01111",
  "10001 10000 10001 10001 10000",
  "10001 10000 10001 10001 10000",
  "11110 11110 11111 11110 01110",
  "10000 10000 10001 10100 00001",
  "10000 10000 10001 10010 00001",
  "10000 11111 10001 10001 11110"
];
const quantityRows = ["11111", "00001", "00010", "00100", "01000", "01000", "01000"];

export async function assertVisionProbeImage(image: Buffer): Promise<void> {
  const metadata = await sharp(image).metadata();
  assert.equal(metadata.format, "png", "vision_probe_format_invalid");
  assert.equal(metadata.width, 480, "vision_probe_width_invalid");
  assert.equal(metadata.height, 360, "vision_probe_height_invalid");
  for (const region of [
    { left: 30, top: 228, width: 150, height: 35, rows: answerRows, gap: true },
    { left: 406, top: 228, width: 25, height: 35, rows: quantityRows, gap: false }
  ]) {
    const pixels = await sharp(image).extract({ left: region.left, top: region.top, width: region.width, height: region.height })
      .flatten({ background: "#ffffff" }).greyscale().raw().toBuffer();
    for (let y = 0; y < region.height; y += 1) {
      const row = region.rows[Math.floor(y / 5)].replaceAll(" ", "0") + (region.gap ? "0" : "");
      for (let x = 0; x < region.width; x += 1) {
        if (pixels[y * region.width + x] !== (row[Math.floor(x / 5)] === "1" ? 0 : 255)) {
          throw new Error("vision_probe_receipt_pixels_invalid");
        }
      }
    }
  }
}
