import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AIQSA_THEMES } from "../../components/app-shell/theme";

type Theme = "dark" | "light";
type Rgb = readonly [number, number, number];

const tokenPath = path.join(process.cwd(), "styles/tokens-v2.css");
const tokens = readFileSync(tokenPath, "utf8");
const tailwindConfig = readFileSync(path.join(process.cwd(), "tailwind.config.ts"), "utf8");

const expected = {
  dark: {
    accent: "#5fbdb2",
    accentInk: "#0e2b27",
    active: "rgb(236 234 228 / 0.09)",
    border: "rgb(236 234 228 / 0.09)",
    border2: "rgb(236 234 228 / 0.16)",
    bubble: "#282722",
    canvas: "#1b1a17",
    codeBg: "#22211e",
    danger: "#e08c84",
    hover: "rgb(236 234 228 / 0.06)",
    ok: "#93bf85",
    sidebar: "#151412",
    surface: "#242320",
    surface2: "#2c2b27",
    text: "#eceae4",
    text2: "#a6a199",
    text3: "#7a766c",
    warn: "#d9b36a"
  },
  light: {
    accent: "#146b63",
    accentInk: "#f4fffd",
    active: "rgb(32 31 27 / 0.08)",
    border: "rgb(32 31 27 / 0.1)",
    border2: "rgb(32 31 27 / 0.18)",
    bubble: "#eeece5",
    canvas: "#faf9f6",
    codeBg: "#f3f1ec",
    danger: "#b4453c",
    hover: "rgb(32 31 27 / 0.05)",
    ok: "#3f7d3a",
    sidebar: "#f1efe9",
    surface: "#ffffff",
    surface2: "#f3f1ec",
    text: "#26241f",
    text2: "#6e6a61",
    text3: "#9b968b",
    warn: "#8a6a1f"
  }
} as const;

function token(theme: Theme, name: string): string {
  const cssName = name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
  const match = tokens.match(
    new RegExp(`--v2-${theme}-color-${cssName}:\\s*([^;]+);`, "u")
  );
  if (!match) throw new Error(`Missing ${theme} ${name}`);
  return match[1]!.trim().toLowerCase();
}

function hex(value: string): Rgb {
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

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(target);
    return entry.isFile() && /\.(?:css|ts|tsx)$/u.test(entry.name) &&
      !/\.(?:test|stories)\.(?:ts|tsx)$/u.test(entry.name)
      ? [target]
      : [];
  });
}

describe("UI v2 theme contract", () => {
  it("exposes exactly System, Light, and Dark", () => {
    expect(AIQSA_THEMES.map((theme) => theme.id)).toEqual(["system", "light", "dark"]);
  });

  it("keeps the approved Stage 3 palette exact", () => {
    for (const theme of ["dark", "light"] as const) {
      for (const [name, value] of Object.entries(expected[theme])) {
        expect(token(theme, name), `${theme} ${name}`).toBe(value);
      }
    }
  });

  it("keeps the approved contrast floors on both reading canvases", () => {
    for (const theme of ["dark", "light"] as const) {
      const canvas = token(theme, "canvas");
      expect(contrast(token(theme, "text"), canvas), `${theme} text`).toBeGreaterThanOrEqual(10);
      expect(contrast(token(theme, "text2"), canvas), `${theme} text2`).toBeGreaterThanOrEqual(5);
      expect(contrast(token(theme, "accent"), canvas), `${theme} accent`).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(token(theme, "accentInk"), token(theme, "accent")),
        `${theme} accent ink`
      ).toBeGreaterThanOrEqual(6.2);
    }
  });

  it("keeps all active v2 theme values in the sole token file", () => {
    const sources = [
      ...productionSources(path.join(process.cwd(), "components/ui-v2")),
      ...productionSources(path.join(process.cwd(), "features"))
    ];
    const violations = sources.flatMap((filename) =>
      readFileSync(filename, "utf8")
        .split(/\r?\n/u)
        .flatMap((line, index) =>
          /#[0-9a-f]{3,8}|\b(?:rgb|rgba|hsl|oklch)\(|\bdark:/iu.test(line)
            ? [`${path.relative(process.cwd(), filename)}:${index + 1}`]
            : []
        )
    );
    expect(violations).toEqual([]);
  });

  it("defines System as a media-selected interpretation and preserves deterministic motion off", () => {
    expect(tokens).toContain(':root[data-theme="system"]');
    expect(tokens).toContain("@media (prefers-color-scheme: dark)");
    expect(readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8")).toContain(
      'html[data-motion="off"] *'
    );
  });

  it("routes retained secondary surfaces directly through the V2 token contract", () => {
    expect(tokens).not.toMatch(/--(?:app-canvas|answer-paper|proof|ink):/u);
    expect(tailwindConfig).toContain('v2Color("--v2-color-canvas")');
    expect(tailwindConfig).toContain('v2Color("--v2-color-accent")');
    expect(tailwindConfig).not.toContain("rgb(var(--app-canvas)");

    const secondaryRoots = [
      "components/admin/AdminPanel.tsx",
      "components/app-shell/ArchivedChatsDialog.tsx",
      "components/app-shell/ShareDialog.tsx",
      "components/auth/AuthLogin.tsx",
      "components/share/PublicShareView.tsx"
    ];
    for (const relativePath of secondaryRoots) {
      const source = readFileSync(path.join(process.cwd(), relativePath), "utf8");
      expect(source, relativePath).toContain('data-ui-presentation="v2-tokens"');
      expect(source, relativePath).not.toMatch(/data-theme=["'{](?:aiqsa|graphite|verdant|neutral|paper|classic)/u);
    }
  });
});
