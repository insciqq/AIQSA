import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AIQSA_THEMES, type ThemeId } from "../../components/app-shell/theme";
import tailwindConfig from "../../tailwind.config";

type Rgb = readonly [number, number, number];

const FOCUS_ALPHA = 0.78;
const CONTROL_BOUNDARY_ALPHA = 0.85;
const COMMON_SURFACES = [
  "research-canvas",
  "workspace-rail",
  "answer-paper",
  "composer-surface",
  "control-surface",
  "overlay-surface",
  "control-hover",
  "control-pressed",
  "control-selected"
] as const;

const styles = readFileSync(
  path.join(process.cwd(), "app/globals.css"),
  "utf8"
);

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(target);
    return entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name) &&
      !/\.(?:test|stories)\.(?:ts|tsx)$/u.test(entry.name)
      ? [target]
      : [];
  });
}

function relative(filename: string): string {
  return path.relative(process.cwd(), filename).split(path.sep).join("/");
}

function cssRule(selector: string): string {
  const selectorIndex = styles.lastIndexOf(selector);
  const blockStart = styles.indexOf("{", selectorIndex);
  const blockEnd = styles.indexOf("\n}", blockStart);

  if (selectorIndex < 0 || blockStart < 0 || blockEnd < 0) {
    throw new Error(`Missing CSS rule for ${selector}`);
  }

  return styles.slice(blockStart + 1, blockEnd);
}

function themeBlock(themeId: ThemeId): string {
  const marker = `[data-theme="${themeId}"]`;
  const markerIndex = styles.indexOf(marker);
  const blockStart = styles.indexOf("{", markerIndex);
  const blockEnd = styles.indexOf("\n}", blockStart);

  if (markerIndex < 0 || blockStart < 0 || blockEnd < 0) {
    throw new Error(`Missing CSS theme block for ${themeId}`);
  }

  return styles.slice(blockStart + 1, blockEnd);
}

function tokenValue(themeId: ThemeId, token: string): Rgb {
  const match = themeBlock(themeId).match(
    new RegExp(`--${token}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+);`, "u")
  );

  if (!match) {
    throw new Error(`Missing --${token} in ${themeId}`);
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function composite(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  return [
    foreground[0] * alpha + background[0] * (1 - alpha),
    foreground[1] * alpha + background[1] * (1 - alpha),
    foreground[2] * alpha + background[2] * (1 - alpha)
  ];
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

function contrastRatio(first: Rgb, second: Rgb): number {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("UI theme contrast contract", () => {
  const sources = ["app", "components"].flatMap((directory) =>
    productionSources(path.join(process.cwd(), directory)));

  it("keeps the semantic Tailwind recipes explicit", () => {
    expect(tailwindConfig.theme.extend.colors).toMatchObject({
      control: {
        boundary: "rgb(var(--ink-muted) / 0.85)"
      },
      focus: "rgb(var(--proof) / 0.78)"
    });
    expect(cssRule(
      'article[data-role]:focus-visible [data-message-interaction-surface="true"]'
    )).toContain("0 0 0 2px rgb(var(--proof) / 0.78);");
  });

  it("keeps component focus recipes on the semantic focus color", () => {
    const violations = sources.flatMap((filename) =>
      readFileSync(filename, "utf8").split(/\r?\n/u).flatMap((line, index) =>
        [...line.matchAll(/\b(?:focus|focus-visible|focus-within):ring-([^\s"'`}]+)/gu)]
          .flatMap((match) => {
            const utility = match[1];
            const offset = utility.startsWith("offset-")
              ? utility.slice("offset-".length)
              : null;
            const allowed = utility === "focus" || utility === "inset" || /^\d+$/u.test(utility) ||
              (offset !== null && (/^\d+$/u.test(offset) || COMMON_SURFACES.some((surface) => surface === offset)));
            return allowed ? [] : [`${relative(filename)}:${index + 1}:${match[0]}`];
          })));

    expect(violations).toEqual([]);
  });

  it("keeps focus indication above 3:1 on common surfaces in every theme", () => {
    for (const theme of AIQSA_THEMES) {
      const proof = tokenValue(theme.id, "proof");

      for (const focusSurface of COMMON_SURFACES) {
        const focus = composite(
          proof,
          tokenValue(theme.id, focusSurface),
          FOCUS_ALPHA
        );

        for (const adjacentSurface of COMMON_SURFACES) {
          expect(
            contrastRatio(focus, tokenValue(theme.id, adjacentSurface)),
            `${theme.id}: focus over ${focusSurface} beside ${adjacentSurface}`
          ).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("keeps necessary control boundaries above 3:1 on common surfaces", () => {
    for (const theme of AIQSA_THEMES) {
      const mutedInk = tokenValue(theme.id, "ink-muted");

      for (const controlSurface of COMMON_SURFACES) {
        const boundary = composite(
          mutedInk,
          tokenValue(theme.id, controlSurface),
          CONTROL_BOUNDARY_ALPHA
        );

        for (const adjacentSurface of COMMON_SURFACES) {
          expect(
            contrastRatio(boundary, tokenValue(theme.id, adjacentSurface)),
            `${theme.id}: control boundary over ${controlSurface} beside ${adjacentSurface}`
          ).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("keeps meaningful muted metadata readable on selected controls", () => {
    for (const theme of AIQSA_THEMES) {
      expect(
        contrastRatio(
          tokenValue(theme.id, "ink-muted"),
          tokenValue(theme.id, "control-selected")
        ),
        `${theme.id}: muted metadata on control-selected`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps selected status text readable over semantic washes", () => {
    for (const theme of AIQSA_THEMES) {
      const selected = tokenValue(theme.id, "control-selected");

      expect(
        contrastRatio(tokenValue(theme.id, "ink-secondary"), selected),
        `${theme.id}: selected secondary text`
      ).toBeGreaterThanOrEqual(4.5);

      for (const tone of ["proof", "positive", "caution", "critical"] as const) {
        const wash = composite(tokenValue(theme.id, tone), selected, 0.1);
        expect(
          contrastRatio(tokenValue(theme.id, "ink"), wash),
          `${theme.id}: selected ${tone} status wash`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
