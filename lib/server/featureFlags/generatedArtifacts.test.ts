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
});
