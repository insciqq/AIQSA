import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRuntimeModulePath } from "./runtimeModulePath";

describe("runtime worker module resolution", () => {
  it.each(["pdf-lib", "unpdf", "@napi-rs/canvas"])(
    "returns a loadable absolute path for %s",
    (specifier) => {
      const resolved = resolveRuntimeModulePath(specifier);

      expect(isAbsolute(resolved)).toBe(true);
      expect(resolved).not.toMatch(/^\[(?:project|externals)\]/u);
    }
  );
});
