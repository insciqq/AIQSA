import { describe, expect, it } from "vitest";
import { dictationLevel } from "./dictationLevelMeter";

function tone(amplitude: number, length = 1024) {
  return Float32Array.from({ length }, (_, index) => amplitude * Math.sin((2 * Math.PI * index) / 32));
}

describe("dictationLevel", () => {
  it("reads silence, an empty block and non-finite samples as 0", () => {
    expect(dictationLevel(new Float32Array(1024))).toBe(0);
    expect(dictationLevel(new Float32Array(0))).toBe(0);
    expect(dictationLevel([Number.NaN, Number.POSITIVE_INFINITY, 0])).toBe(0);
    // Far below the floor (about -100 dBFS) is still silence.
    expect(dictationLevel(tone(1e-5))).toBe(0);
  });

  it("rises with loudness on a dB-like scale", () => {
    const quiet = dictationLevel(tone(0.005));
    const speech = dictationLevel(tone(0.05));
    const loud = dictationLevel(tone(0.2));
    expect(quiet).toBeGreaterThan(0);
    expect(speech).toBeGreaterThan(quiet);
    expect(loud).toBeGreaterThan(speech);
    // Each tenfold step in amplitude is the same 20 dB step.
    expect(speech - quiet).toBeCloseTo(20 / 48, 5);
  });

  it("stays within 0..1 for clipped input", () => {
    expect(dictationLevel(tone(1))).toBe(1);
    expect(dictationLevel(Float32Array.from({ length: 64 }, () => 4))).toBe(1);
    for (const amplitude of [1e-4, 0.001, 0.01, 0.1, 0.5]) {
      const level = dictationLevel(tone(amplitude));
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(1);
    }
  });
});
