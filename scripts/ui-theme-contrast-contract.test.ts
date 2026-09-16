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

function composite(foreground: string, background: string): Rgb {
  const match = /^rgb\((\d+) (\d+) (\d+) \/ (0(?:\.\d+)?|1)\)$/u.exec(foreground);
  if (!match) throw new Error(`Invalid translucent contrast color ${foreground}`);
  const alpha = Number(match[4]);
  const base = hex(background);
  const channel = (index: number) => Number(match[index + 1]) * alpha + base[index]! * (1 - alpha);
  return [channel(0), channel(1), channel(2)];
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

function contrast(first: string | Rgb, second: string | Rgb): number {
  const firstLuminance = luminance(typeof first === "string" ? hex(first) : first);
  const secondLuminance = luminance(typeof second === "string" ? hex(second) : second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05);
}

describe("UI theme contrast", () => {
  it.each(["dark", "light"] as const)("keeps ordinary selections visible and readable in %s", (theme) => {
    for (const surface of ["canvas", "surface", "bubble", "code-bg"]) {
      const background = token(theme, surface);
      const selection = composite(token(theme, "selection"), background);
      expect(contrast(selection, background), `${surface} highlight`).toBeGreaterThanOrEqual(theme === "dark" ? 1.9 : 1.35);
      expect(contrast(token(theme, "text"), selection), `${surface} selected text`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(["dark", "light"] as const)("keeps syntax colors readable on code selections in %s", (theme) => {
    const background = token(theme, "code-bg");
    const selection = composite(token(theme, "selection-code"), background);
    expect(contrast(selection, background), "code highlight").toBeGreaterThanOrEqual(theme === "dark" ? 1.5 : 1.28);
    for (const role of ["text", "accent2", "ok", "text3", "accent", "warn", "text2"]) {
      expect(contrast(token(theme, role), selection), role).toBeGreaterThanOrEqual(3);
    }
  });

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
