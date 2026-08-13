import { isTestModeAllowedEnv } from "../auth/csrf";

export const GENERATED_ARTIFACTS_PRODUCT_RELEASED = false;

export type GeneratedArtifactsFeatureMode = "disabled" | "fixtures" | "product";

export function generatedArtifactsFeatureMode(
  environment: Readonly<Record<string, string | undefined>> = process.env
): GeneratedArtifactsFeatureMode {
  if (GENERATED_ARTIFACTS_PRODUCT_RELEASED) return "product";
  return isTestModeAllowedEnv(environment) ? "fixtures" : "disabled";
}
