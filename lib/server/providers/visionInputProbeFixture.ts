// A tiny fixed alphabet drawn as geometry, so rendering never depends on host
// fonts, fontconfig, or the SVG backend's text support.
const glyphs: Readonly<Record<string, readonly string[]>> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"]
};

function label(text: string, left: number, top: number): string {
  return [...text].map((character, index) => {
    const glyph = glyphs[character];
    if (!glyph) throw new Error("vision_input_fixture_unavailable");
    return glyph.flatMap((row, y) => [...row].map((pixel, x) => pixel === "1"
      ? `<rect x="${left + index * 36 + x * 6}" y="${top + y * 6}" width="6" height="6"/>`
      : "")).join("");
  }).join("");
}

export function visionInputProbeSvg(code: string): string {
  return `<svg width="640" height="240" xmlns="http://www.w3.org/2000/svg">
    <rect width="640" height="240" fill="white"/>
    <path d="M20 20H620V220H20ZM20 120H620M300 20V220" fill="none" stroke="black" stroke-width="4"/>
    <g fill="black">${label("ALPHA", 70, 45)}${label("17", 390, 45)}${label("BETA", 75, 145)}${label(code, 345, 145)}</g>
  </svg>`;
}
