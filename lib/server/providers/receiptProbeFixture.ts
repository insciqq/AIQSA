export const RECEIPT_PROBE_ANSWER = "PEARS";
export const RECEIPT_PROBE_WIDTH = 480;
export const RECEIPT_PROBE_HEIGHT = 360;

const glyphs: Readonly<Record<string, readonly string[]>> = Object.freeze({
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"]
});

function drawRectangle(
  raster: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  value = 0
): void {
  for (let row = Math.max(0, y); row < Math.min(RECEIPT_PROBE_HEIGHT, y + height); row += 1) {
    const offset = row * RECEIPT_PROBE_WIDTH;
    for (let column = Math.max(0, x); column < Math.min(RECEIPT_PROBE_WIDTH, x + width); column += 1) {
      raster[offset + column] = value;
    }
  }
}

function drawRasterText(
  raster: Uint8Array,
  text: string,
  x: number,
  y: number,
  scale: number
): void {
  let cursor = x;
  for (const character of text) {
    const glyph = glyphs[character];
    if (!glyph) throw new Error("receipt_probe_glyph_missing");
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((pixel, columnIndex) => {
        if (pixel === "1") {
          drawRectangle(
            raster,
            cursor + columnIndex * scale,
            y + rowIndex * scale,
            scale,
            scale
          );
        }
      });
    });
    cursor += 6 * scale;
  }
}

export function receiptProbeRaster(): Uint8Array {
  const raster = new Uint8Array(RECEIPT_PROBE_WIDTH * RECEIPT_PROBE_HEIGHT);
  raster.fill(255);

  // Original synthetic receipt and bitmap lettering: no third-party document,
  // font, encryption, hidden text layer or network dependency. Fixed geometry
  // and Flate encoding make the reviewed bytes reproducible.
  drawRasterText(raster, "MARKET RECEIPT", 30, 28, 5);
  drawRectangle(raster, 30, 82, 420, 2);
  drawRasterText(raster, "ITEM", 30, 108, 4);
  drawRasterText(raster, "QTY", 358, 108, 4);
  drawRasterText(raster, "APPLES", 30, 166, 5);
  drawRasterText(raster, "4", 406, 166, 5);
  drawRasterText(raster, RECEIPT_PROBE_ANSWER, 30, 228, 5);
  drawRasterText(raster, "7", 406, 228, 5);
  drawRectangle(raster, 30, 282, 420, 2);
  drawRasterText(raster, "TOTAL", 30, 304, 4);
  drawRasterText(raster, "11", 382, 304, 4);
  return raster;
}
