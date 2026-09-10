import sharp from "sharp";
import { createImageGenerationAdapter, ImageGenerationError } from "../../providers/imageGeneration";
import { decodeImageVerificationEvidence } from "../../providers/imageGenerationEvidence";
import { imageParameterDefinitions, type ImageGenerationParameters } from "../../../contracts/imageGeneration";
import type { AdminProviderCapabilityCheckStatus, AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import type { AdminProviderDraftTesterInput, AdminProviderDraftTestOutcome } from "./tester";
import type { ProviderConnectionConfiguration } from "../../providers/providerConfiguration";
import { unsupportedAdminProviderCompatibilityEvidence } from "./compatibilityEvidence";

/** Two separate requests and deadlines; a failed generator does not suppress the editor probe. */
export async function testImageCapabilities(input: AdminProviderDraftTesterInput, options: {
  createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
}): Promise<AdminProviderDraftTestOutcome> {
  const model = input.model;
  if (!model.image || ["anthropic", "deepseek"].includes(input.providerFamily)) throw new Error("provider_image_configuration_invalid");
  const checks: NonNullable<AdminProviderTestEvidence["capabilitySetup"]>["checks"] = {
    modelAccess: "not_checked", imageGeneration: "not_checked", imageEditing: "not_checked"
  };
  const evidence: AdminProviderTestEvidence = {
    detail: "model_missing", method: input.mode === "account_catalog" ? "openrouter_account_catalog" : "tiny_generation",
    upstreamModelId: model.upstreamModelId, selectedProviders: model.openRouterRouting?.providers ?? [],
    compatibility: unsupportedAdminProviderCompatibilityEvidence(), capabilitySetup: { policyVersion: 1, checks }
  };
  const definitions = imageParameterDefinitions(model.image, model.upstreamModelId);
  const parameters: ImageGenerationParameters = {};
  for (const [name, value] of [["quality", "low"], ["image_size", "1K"], ["resolution", "1K"], ["thinking_level", "minimal"]] as const) {
    const definition = definitions[name];
    if (definition?.type === "enum" && definition.values.includes(value)) parameters[name] = value;
  }
  const adapter = createImageGenerationAdapter({ connection: input.connection, model, secret: input.secret ?? "",
    ...(options.createFetch ? { fetchFn: options.createFetch(input.connection) } : {}) });
  const reference = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#ee2828" } }).png().toBuffer();
  let completed = 0;
  const snapshot = (): AdminProviderDraftTestOutcome => {
    const available = checks.imageGeneration === "verified" || checks.imageEditing === "verified";
    checks.modelAccess = available ? "verified" : "incomplete";
    evidence.detail = available ? "ok" : "model_missing";
    evidence.compatibility!.modelAccess = available ? "verified" : "not_supported";
    return { status: available ? "available" : "unavailable", evidence: structuredClone(evidence) };
  };
  for (const capability of ["imageGeneration", "imageEditing"] as const) {
    input.signal?.throwIfAborted();
    input.onCapabilityProgress?.({ capability, completed, total: 2 });
    const previous = input.reuseSetupEvidence;
    const proof = decodeImageVerificationEvidence(previous?.[capability]);
    if (previous?.capabilitySetup?.checks[capability] === "verified" && proof?.adapterKind === model.adapterKind && proof.upstreamModelId === model.upstreamModelId) {
      checks[capability] = "verified";
      evidence[capability] = proof;
    } else {
      try {
        const result = await adapter.generate({
          prompt: capability === "imageGeneration" ? "Create one simple flat image: a blue circle centered on a white background, no text."
            : "Edit this image: retain its red background and add a large white circle in the center. Return one image.",
          ...(capability === "imageEditing" ? { images: [{ bytes: reference, mimeType: "image/png" as const }] } : {}),
          parameters, signal: AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(60_000)])
        });
        if (capability === "imageEditing" && Buffer.from(result.bytes).equals(reference)) {
          checks[capability] = "rejected";
        } else {
          checks[capability] = "verified";
          evidence[capability] = { adapterKind: model.adapterKind, upstreamModelId: model.upstreamModelId, probeVersion: 1, verified: true };
        }
      } catch (error) {
        input.signal?.throwIfAborted();
        let status: AdminProviderCapabilityCheckStatus = "incomplete";
        if (error instanceof ImageGenerationError) {
          if ([404, 405].includes(error.httpStatus ?? 0)) status = "unsupported";
          else if ([400, 422].includes(error.httpStatus ?? 0)) status = "rejected";
          else if (["image_response_invalid", "image_output_missing"].includes(error.code)) status = "rejected";
        }
        checks[capability] = status;
      }
    }
    completed += 1;
    input.onSetupCheckpoint?.(snapshot());
    input.onCapabilityProgress?.({ capability, completed, total: 2 });
  }
  return snapshot();
}
