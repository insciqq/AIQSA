import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import tailwindConfig from "../../tailwind.config";

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

describe("UI typography contract", () => {
  const sources = ["app", "components"].flatMap((directory) =>
    productionSources(path.join(process.cwd(), directory)));

  it("keeps meaningful metadata above the raw 10-11px escape hatch", () => {
    const violations = sources.flatMap((filename) =>
      readFileSync(filename, "utf8").split(/\r?\n/u).flatMap((line, index) =>
        /text-\[(?:10|11)px\]/u.test(line)
          ? [`${relative(filename)}:${index + 1}`]
          : []));

    expect(violations).toEqual([]);
  });

  it("keeps the semantic metadata recipe at the documented readable scale", () => {
    expect(tailwindConfig.theme.extend.fontSize).toMatchObject({
      incidental: ["0.6875rem", { lineHeight: "1rem" }],
      metadata: ["0.75rem", { lineHeight: "1.5" }]
    });

    const unsafeLeading = sources.flatMap((filename) =>
      readFileSync(filename, "utf8").split(/\r?\n/u).flatMap((line, index) =>
        /text-metadata.*\bleading-(?:3|4|none|tight)\b|\bleading-(?:3|4|none|tight)\b.*text-metadata/u
          .test(line)
          ? [`${relative(filename)}:${index + 1}`]
          : []));
    expect(unsafeLeading).toEqual([]);
  });

  it("allows incidental microtype only on redundant hidden markers", () => {
    const violations = sources.flatMap((filename) => {
      const source = readFileSync(filename, "utf8");
      const uses = source.match(/\btext-incidental\b/gu) ?? [];
      const tags = source.match(/<[^>]*\btext-incidental\b[^>]*>/gsu) ?? [];
      return uses.length !== tags.length || tags.some((tag) => !/aria-hidden=["']true["']/u.test(tag))
        ? [relative(filename)]
        : [];
    });

    expect(violations).toEqual([]);
  });
});
