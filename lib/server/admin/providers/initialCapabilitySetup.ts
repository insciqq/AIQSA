import {
  ADMIN_PROVIDER_CAPABILITY_CHECKS,
  type AdminProviderCapabilitySetupEvidence,
  type AdminProviderTestEvidence
} from "../../../contracts/adminProviders";
import type { ProviderModelConfiguration } from "../../providers/providerConfiguration";
import { decodeParallelToolCallVerificationEvidence } from "../../providers/parallelToolCallEvidence";
import { decodePdfInputVerificationEvidence } from "../../providers/pdfInputEvidence";
import { decodeVisionInputVerificationEvidence } from "../../providers/visionInputEvidence";
import { hasVerifiedForcedToolCall } from "../../providers/forcedToolCallEvidence";
import { hasVerifiedStructuredOutput } from "../../providers/structuredOutputEvidence";

export const INITIAL_CAPABILITY_SETUP_POLICY_VERSION = 1 as const;
export const INITIAL_CAPABILITY_MODEL_TIMEOUT_MS = 180_000;
export const INITIAL_CAPABILITY_BATCH_TIMEOUT_MS = 30 * 60_000;

export function initialModelConfiguration(model: ProviderModelConfiguration): ProviderModelConfiguration {
  return model.modelClass === "answer" ? { ...model, capabilities: { ...model.capabilities,
    toolCalling: false, parallelToolCalls: false, vision: false, nativePdfInput: false, streaming: false
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
  if (candidate.policyVersion !== INITIAL_CAPABILITY_SETUP_POLICY_VERSION ||
    !candidate.checks || typeof candidate.checks !== "object" || Array.isArray(candidate.checks) ||
    Object.keys(candidate).some((key) => key !== "policyVersion" && key !== "checks")) return null;
  const entries = Object.entries(candidate.checks);
  if (!entries.length || entries.some(([key, status]) =>
    !(ADMIN_PROVIDER_CAPABILITY_CHECKS as readonly string[]).includes(key) ||
    typeof status !== "string" || !["verified", "rejected", "unsupported", "incomplete", "not_checked"].includes(status))) return null;
  return { policyVersion: INITIAL_CAPABILITY_SETUP_POLICY_VERSION,
    checks: Object.fromEntries(entries) as AdminProviderCapabilitySetupEvidence["checks"] };
}

export function capabilitySetupIncomplete(evidence: AdminProviderTestEvidence): boolean {
  const setup = decodeCapabilitySetupEvidence(evidence.capabilitySetup);
  return !setup || Object.values(setup.checks).some((status) => status !== "verified" && status !== "unsupported");
}

/** Use only during the authorized initial setup or an exact-current setup retry.
 * A later administrator model edit changes its revision and closes this path. */
export function initiallyVerifiedModelConfiguration(
  model: ProviderModelConfiguration,
  evidence: AdminProviderTestEvidence
): ProviderModelConfiguration {
  const setup = decodeCapabilitySetupEvidence(evidence.capabilitySetup);
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
  const setup = decodeCapabilitySetupEvidence(evidence?.capabilitySetup);
  if (!evidence || !setup || evidence.upstreamModelId !== model.upstreamModelId ||
    evidence.detail !== "ok" || evidence.method !== "tiny_generation" ||
    setup.checks.modelAccess !== "verified" || evidence.compatibility?.modelAccess !== "verified") return undefined;
  if ((setup.checks.structuredOutput === "verified" && !hasVerifiedStructuredOutput(evidence, model)) ||
    (setup.checks.forcedToolCall === "verified" && !hasVerifiedForcedToolCall(evidence, model))) return undefined;
  for (const [check, proof] of [
    ["vision", decodeVisionInputVerificationEvidence(evidence.visionInput)],
    ["directPdf", decodePdfInputVerificationEvidence(evidence.pdfInput)],
    ["parallelToolCalls", decodeParallelToolCallVerificationEvidence(evidence.parallelToolCalls)]
  ] as const) {
    if (setup.checks[check] === "verified" &&
      (proof?.adapterKind !== model.adapterKind || proof.upstreamModelId !== model.upstreamModelId)) return undefined;
  }
  return evidence;
}
