import { artifactContentSecurityPolicy } from "../../contracts/artifacts";
import { ARTIFACT_VIEW_SANDBOX } from "../../contracts/artifactRuntime";

// Next's proxy response headers can replace route response headers. Both
// boundaries must emit the same policy for authored content and downloads.
export const ARTIFACT_RESPONSE_CSP = `sandbox ${ARTIFACT_VIEW_SANDBOX}; ${artifactContentSecurityPolicy()}`;
