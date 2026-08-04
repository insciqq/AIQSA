// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { globSync } from "tinyglobby";

describe("production request body boundary", () => {
  it("does not allow direct request.json or request.formData outside the bounded owner", () => {
    const directRequestBodyParser =
      /\b(?:request|req)(?:\s*\.\s*clone\s*\(\s*\))?\s*(?:\?\.|\.)\s*(?:json|formData)\s*\(/;
    const offenders = ["app", "lib/server"].flatMap((relativeRoot) => {
      const root = resolve(process.cwd(), relativeRoot);

      return globSync(["**/*.{ts,tsx,js,mjs,cjs}"], { cwd: root })
        .filter(
          (path) =>
            !/\.(?:integration\.)?test\.[^.]+$/.test(path) &&
            `${relativeRoot}/${path}` !== "lib/server/http/requestBody.ts"
        )
        .filter((path) => directRequestBodyParser.test(readFileSync(resolve(root, path), "utf8")))
        .map((path) => `${relativeRoot}/${path}`);
    });

    expect(offenders).toEqual([]);
  });
});
