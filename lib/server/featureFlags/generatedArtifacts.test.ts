import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENERATED_ARTIFACTS_PRODUCT_RELEASED,
  generatedArtifactsFeatureMode
} from "./generatedArtifacts";

describe("generated artifact presentation feature gate", () => {
  it("is disabled for production even when test switches are present", () => {
    expect(GENERATED_ARTIFACTS_PRODUCT_RELEASED).toBe(false);
    expect(generatedArtifactsFeatureMode({
      AIQSA_TEST_MODE: "1",
      NODE_ENV: "production",
      PLAYWRIGHT_TEST_AUTH: "1"
    })).toBe("disabled");
  });

  it("exposes deterministic fixtures only inside explicit non-production test mode", () => {
    expect(generatedArtifactsFeatureMode({ NODE_ENV: "development" })).toBe("disabled");
    expect(generatedArtifactsFeatureMode({
      AIQSA_TEST_MODE: "1",
      NODE_ENV: "development"
    })).toBe("fixtures");
  });

  it("keeps the fixture import behind the server gate and out of the ordinary shell", () => {
    const root = process.cwd();
    const fixturePage = readFileSync(path.join(root, "app/ui-v2-fixture/page.tsx"), "utf8");
    const gateCall = fixturePage.indexOf("generatedArtifactsFeatureMode(process.env)");
    const fixtureImport = fixturePage.indexOf(
      '"@/features/artifacts-v2/ArtifactsV2Gallery"'
    );
    expect(gateCall).toBeGreaterThan(0);
    expect(fixtureImport).toBeGreaterThan(gateCall);
    for (const file of [
      "features/workspace-v2/PowerAppShellV2.tsx",
      "features/workspace-v2/PowerAppShellV2View.tsx"
    ]) {
      expect(readFileSync(path.join(root, file), "utf8")).not.toContain("artifacts-v2");
    }
  });
});
