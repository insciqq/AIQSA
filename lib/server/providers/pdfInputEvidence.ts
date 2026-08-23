import type { CatalogAdapterKind } from "../../domain/catalog";

export const PDF_INPUT_SUPPORTED_ADAPTERS = [
  "anthropic_messages",
  "gemini_interactions_native",
  "openai_responses_compatible",
  "openai_responses_native",
  "openrouter_chat_completions"
] as const;

export type PdfInputAdapterKind = typeof PDF_INPUT_SUPPORTED_ADAPTERS[number];

export type PdfInputVerificationEvidence = Readonly<{
  adapterKind: PdfInputAdapterKind;
  probeVersion: 1;
  upstreamModelId: string;
  verified: true;
}>;

export type PdfInputVerificationStatus =
  | "not_requested"
  | "not_verified"
  | "unsupported"
  | "verified";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsPdfInputAdapter(
  adapterKind: CatalogAdapterKind | string
): adapterKind is PdfInputAdapterKind {
  return (PDF_INPUT_SUPPORTED_ADAPTERS as readonly string[]).includes(adapterKind);
}

export function pdfInputVerificationEvidence(
  adapterKind: CatalogAdapterKind | string,
  upstreamModelId: string
): PdfInputVerificationEvidence | null {
  return supportsPdfInputAdapter(adapterKind) && upstreamModelId.trim()
    ? {
        adapterKind,
        probeVersion: 1,
        upstreamModelId: upstreamModelId.trim(),
        verified: true
      }
    : null;
}

export function decodePdfInputVerificationEvidence(
  value: unknown
): PdfInputVerificationEvidence | null {
  if (
    !isRecord(value) ||
    value.verified !== true ||
    value.probeVersion !== 1 ||
    typeof value.adapterKind !== "string" ||
    !supportsPdfInputAdapter(value.adapterKind) ||
    typeof value.upstreamModelId !== "string" ||
    !value.upstreamModelId.trim() ||
    value.upstreamModelId !== value.upstreamModelId.trim() ||
    value.upstreamModelId.length > 512
  ) return null;

  return {
    adapterKind: value.adapterKind,
    probeVersion: 1,
    upstreamModelId: value.upstreamModelId,
    verified: true
  };
}

export function hasVerifiedPdfInput(
  evidence: unknown,
  model: Readonly<{
    adapterKind: CatalogAdapterKind | string;
    upstreamModelId: string;
  }>
): boolean {
  if (!isRecord(evidence)) return false;
  const verification = decodePdfInputVerificationEvidence(evidence.pdfInput);
  return verification?.adapterKind === model.adapterKind &&
    verification.upstreamModelId === model.upstreamModelId;
}

export function pdfInputVerificationStatus(
  evidence: unknown,
  model: Readonly<{
    adapterKind: CatalogAdapterKind | string;
    capabilities: Readonly<{ nativePdfInput: boolean }>;
    upstreamModelId: string;
  }>
): PdfInputVerificationStatus {
  if (!model.capabilities.nativePdfInput) return "not_requested";
  if (!supportsPdfInputAdapter(model.adapterKind)) return "unsupported";
  return hasVerifiedPdfInput(evidence, model) ? "verified" : "not_verified";
}
