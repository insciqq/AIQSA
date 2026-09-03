import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Theme = "dark" | "light";
type Rgb = readonly [number, number, number];

const tokens = readFileSync(
  path.join(process.cwd(), "styles/tokens-v2.css"),
  "utf8"
);

function token(theme: Theme, name: string): string {
  const match = tokens.match(
    new RegExp(`--v2-${theme}-color-${name}:\\s*([^;]+);`, "u")
  );
  if (!match) throw new Error(`Missing ${theme} ${name}`);
  return match[1]!.trim().toLowerCase();
}

function componentToken(name: string): string {
  const match = tokens.match(new RegExp(`--v2-${name}:\\s*([^;]+);`, "u"));
  if (!match) throw new Error(`Missing component token ${name}`);
  return match[1]!.trim().toLowerCase();
}

function hex(value: string): Rgb {
  if (!/^#[0-9a-f]{6}$/u.test(value)) throw new Error(`Invalid contrast color ${value}`);
  const parsed = Number.parseInt(value.slice(1), 16);
  return [(parsed >> 16) & 255, (parsed >> 8) & 255, parsed & 255];
}

function linearChannel(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(color: Rgb): number {
  return 0.2126 * linearChannel(color[0]) +
    0.7152 * linearChannel(color[1]) +
    0.0722 * linearChannel(color[2]);
}

function contrast(first: string, second: string): number {
  const firstLuminance = luminance(hex(first));
  const secondLuminance = luminance(hex(second));
  return (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05);
}

describe("UI theme contrast", () => {
  it.each(["dark", "light"] as const)(
    "keeps readable contrast floors for the %s theme",
    (theme) => {
      const canvas = token(theme, "canvas");
      expect(contrast(token(theme, "text"), canvas), "primary text")
        .toBeGreaterThanOrEqual(10);
      expect(contrast(token(theme, "text2"), canvas), "secondary text")
        .toBeGreaterThanOrEqual(5);
      expect(contrast(token(theme, "accent"), canvas), "accent")
        .toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(token(theme, "accent-ink"), token(theme, "accent")),
        "accent ink"
      ).toBeGreaterThanOrEqual(6.2);
    }
  );

  it("keeps every Assistant avatar initial readable", () => {
    for (const palette of [
      "coral",
      "ember",
      "meadow",
      "ocean",
      "pine",
      "plum",
      "sand",
      "slate"
    ]) {
      expect(
        contrast(
          componentToken(`avatar-${palette}-fg`),
          componentToken(`avatar-${palette}-bg`)
        ),
        palette
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
