import {
  ADMIN_PROVIDER_CAPABILITY_CHECKS,
  decodeAdminProviderCapabilityAttempts,
  type AdminProviderCapabilitySetupEvidence,
  type AdminProviderTestEvidence
} from "../../../contracts/adminProviders";
import type { ProviderModelConfiguration } from "../../providers/providerConfiguration";
import { decodeParallelToolCallVerificationEvidence } from "../../providers/parallelToolCallEvidence";
import { decodePdfInputVerificationEvidence } from "../../providers/pdfInputEvidence";
import { decodeVisionInputVerificationEvidence } from "../../providers/visionInputEvidence";
import { hasVerifiedForcedToolCall } from "../../providers/forcedToolCallEvidence";
import { hasVerifiedStructuredOutput } from "../../providers/structuredOutputEvidence";
import { supportsStructuredOutputAdapter } from "../../providers/structuredOutput";
import { decodeImageVerificationEvidence } from "../../providers/imageGenerationEvidence";

export const INITIAL_CAPABILITY_SETUP_POLICY_VERSION = 2 as const;
export const INITIAL_CAPABILITY_MODEL_TIMEOUT_MS = 180_000;
export const INITIAL_CAPABILITY_BATCH_TIMEOUT_MS = 30 * 60_000;

export function initialModelConfiguration(model: ProviderModelConfiguration): ProviderModelConfiguration {
  return model.modelClass === "answer" ? { ...model, capabilities: { ...model.capabilities,
    toolCalling: false, parallelToolCalls: false, vision: false, nativePdfInput: false, streaming: false
  } } : model.modelClass === "image" ? { ...model, capabilities: { ...model.capabilities,
    imageGeneration: false, imageEditing: false
  } } : model;
}

export function pendingInitialCapabilityEvidence(model: ProviderModelConfiguration): AdminProviderTestEvidence {
  return { detail: "model_missing", method: "tiny_generation", selectedProviders: model.openRouterRouting?.providers ?? [],
    upstreamModelId: model.upstreamModelId, capabilitySetup: { policyVersion: INITIAL_CAPABILITY_SETUP_POLICY_VERSION,
      checks: { modelAccess: "not_checked" } } };
}

export function decodeCapabilitySetupEvidence(value: unknown): AdminProviderCapabilitySetupEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if ((candidate.policyVersion !== 1 && candidate.policyVersion !== INITIAL_CAPABILITY_SETUP_POLICY_VERSION) ||
    !candidate.checks || typeof candidate.checks !== "object" || Array.isArray(candidate.checks) ||
    Object.keys(candidate).some((key) => !["policyVersion", "checks", "attempts", "activation"].includes(key)) ||
    candidate.activation !== undefined && candidate.activation !== "initial" && candidate.activation !== "preserve") return null;
  const entries = Object.entries(candidate.checks);
  if (!entries.length || entries.some(([key, status]) =>
    !(ADMIN_PROVIDER_CAPABILITY_CHECKS as readonly string[]).includes(key) ||
    typeof status !== "string" || !["verified", "rejected", "unsupported", "incomplete", "not_checked"].includes(status))) return null;
  const attempts = candidate.attempts === undefined ? undefined : decodeAdminProviderCapabilityAttempts(candidate.attempts);
  if (attempts === null) return null;
  return { policyVersion: candidate.policyVersion,
    ...(candidate.activation ? { activation: candidate.activation } : {}), ...(attempts ? { attempts } : {}),
    checks: Object.fromEntries(entries) as AdminProviderCapabilitySetupEvidence["checks"] };
}

export function capabilitySetupIncomplete(evidence: AdminProviderTestEvidence): boolean {
  const setup = decodeCapabilitySetupEvidence(evidence.capabilitySetup);
  return !setup || Object.values(setup.checks).some((status) => status !== "verified" && status !== "unsupported");
}

export function settledUnsupportedImageCapabilities(evidence: AdminProviderTestEvidence): boolean {
  const setup = decodeCapabilitySetupEvidence(evidence.capabilitySetup);
  return setup?.policyVersion === INITIAL_CAPABILITY_SETUP_POLICY_VERSION &&
    setup.checks.modelAccess === "unsupported" && setup.checks.imageGeneration === "unsupported" && setup.checks.imageEditing === "unsupported";
}

/** Use only during the authorized initial setup or an exact-current setup retry.
 * A later administrator model edit changes its revision and closes this path. */
export function initiallyVerifiedModelConfiguration(
  model: ProviderModelConfiguration,
  evidence: AdminProviderTestEvidence
): ProviderModelConfiguration {
  const setup = decodeCapabilitySetupEvidence(evidence.capabilitySetup);
  if (setup?.activation === "preserve") return model;
  if (setup && model.modelClass === "image") {
    const verified = (capability: "imageGeneration" | "imageEditing") => {
      const proof = decodeImageVerificationEvidence(evidence[capability]);
      return setup.checks[capability] === "verified" && proof?.adapterKind === model.adapterKind && proof.upstreamModelId === model.upstreamModelId;
    };
    return { ...model, capabilities: { ...model.capabilities, imageGeneration: verified("imageGeneration"), imageEditing: verified("imageEditing") } };
  }
  if (!setup || model.modelClass !== "answer") return model;
  const matching = (proof: { adapterKind: string; upstreamModelId: string } | null) =>
    proof?.adapterKind === model.adapterKind && proof.upstreamModelId === model.upstreamModelId;
  return { ...model, capabilities: {
    ...model.capabilities,
    toolCalling: setup.checks.toolCalling === "verified" && evidence.compatibility?.toolCalling === "verified",
    parallelToolCalls: setup.checks.parallelToolCalls === "verified" &&
      matching(decodeParallelToolCallVerificationEvidence(evidence.parallelToolCalls)),
    nativePdfInput: setup.checks.directPdf === "verified" && matching(decodePdfInputVerificationEvidence(evidence.pdfInput)),
    vision: setup.checks.vision === "verified" && matching(decodeVisionInputVerificationEvidence(evidence.visionInput)),
    streaming: setup.checks.streaming === "verified" && evidence.compatibility?.streaming === "verified"
  } };
}

/** The repository caller must first fence all connection/model/key revisions. */
export function reusableCapabilitySetupEvidence(
  evidence: AdminProviderTestEvidence | undefined,
  model: ProviderModelConfiguration
): AdminProviderTestEvidence | undefined {
  let setup = decodeCapabilitySetupEvidence(evidence?.capabilitySetup);
  if (!setup && evidence && model.modelClass === "answer" && evidence.compatibility?.modelAccess === "verified") {
    // Legacy ordinary checks have positive proofs but no capability receipt.
    // Their negative/default flags never establish settled incompatibility.
    const checks: AdminProviderCapabilitySetupEvidence["checks"] = { modelAccess: "verified" };
    for (const key of ["structuredOutput", "toolCalling", "forcedToolCall", "parallelToolCalls", "vision", "directPdf", "streaming"] as const) {
      checks[key] = evidence.compatibility[key] === "verified" ? "verified" : "not_checked";
    }
    setup = { policyVersion: 1, activation: "preserve", checks };
  }
  if (!evidence || !setup || evidence.upstreamModelId !== model.upstreamModelId ||
    !["tiny_generation", "openrouter_account_catalog"].includes(evidence.method)) return undefined;
  if (model.modelClass === "image" && evidence.detail === "model_missing" && settledUnsupportedImageCapabilities(evidence)) {
    // Negative-only receipts suppress redundant probes; they grant no capability.
    return { detail: "model_missing", method: evidence.method, selectedProviders: evidence.selectedProviders,
      upstreamModelId: model.upstreamModelId, capabilitySetup: setup };
  }
  if (evidence.detail !== "ok" ||
    setup.checks.modelAccess !== "verified" || evidence.compatibility?.modelAccess !== "verified") return undefined;
  const checks = { ...setup.checks };
  if (checks.structuredOutput === "unsupported" &&
    setup.attempts?.structuredOutput?.reason === "adapter_unsupported" &&
    supportsStructuredOutputAdapter(model.adapterKind)) checks.structuredOutput = "not_checked";
  const retained = { ...evidence, ...(evidence.compatibility ? { compatibility: { ...evidence.compatibility } } : {}) };
  for (const [key, valid] of [["structuredOutput", hasVerifiedStructuredOutput(evidence, model)],
    ["forcedToolCall", hasVerifiedForcedToolCall(evidence, model)]] as const) {
    if (!valid) {
      if (checks[key] === "verified") checks[key] = "not_checked";
      delete retained[key];
      if (retained.compatibility) retained.compatibility[key] = "not_supported";
    }
  }
  for (const [check, proof] of [
    ["vision", decodeVisionInputVerificationEvidence(evidence.visionInput)],
    ["directPdf", decodePdfInputVerificationEvidence(evidence.pdfInput)],
    ["parallelToolCalls", decodeParallelToolCallVerificationEvidence(evidence.parallelToolCalls)],
    ["imageGeneration", decodeImageVerificationEvidence(evidence.imageGeneration)],
    ["imageEditing", decodeImageVerificationEvidence(evidence.imageEditing)]
  ] as const) {
    if (proof?.adapterKind !== model.adapterKind || proof.upstreamModelId !== model.upstreamModelId) {
      if (checks[check] === "verified") checks[check] = "not_checked";
      const field = check === "vision" ? "visionInput" : check === "directPdf" ? "pdfInput" : check;
      delete retained[field];
      if (retained.compatibility && check !== "imageGeneration" && check !== "imageEditing") retained.compatibility[check] = "not_supported";
    }
  }
  for (const check of ["toolCalling", "streaming"] as const) if (checks[check] === "verified" && evidence.compatibility?.[check] !== "verified") checks[check] = "not_checked";
  for (const key of ADMIN_PROVIDER_CAPABILITY_CHECKS) if (checks[key] === "unsupported" && setup.policyVersion === 1) checks[key] = "not_checked";
  return { ...retained, capabilitySetup: { ...setup, checks } };
}
