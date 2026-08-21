import type { ModelRunUsage } from "../../domain/modelRunEvents";
import type { ParsedBoundingBox } from "../parsing";

/** Historical citation payload version; query-time visual execution is retired. */
export const KNOWLEDGE_VISUAL_ANALYSIS_VERSION = 1 as const;
const MAX_DESCRIPTION_CHARACTERS = 4_000;
const MAX_LABEL_CHARACTERS = 1_000;
const MAX_VISUAL_BOXES = 16;

export type KnowledgeVisualRegionKind = "chart" | "diagram" | "image" | "table";

export type KnowledgeVisualProviderEvidence = Readonly<{
  modelId: string;
  profileRevisionId: string;
  provider: string;
  providerModelId: string;
  usage: ModelRunUsage;
}>;

export type KnowledgeVisualAnalysisResult = Readonly<{
  assetId: string | null;
  blockId: string;
  boundingBoxes: readonly ParsedBoundingBox[];
  caption: string | null;
  description: string | null;
  headingPath: readonly string[];
  kind: KnowledgeVisualRegionKind;
  label: string;
  page: number;
  provider: KnowledgeVisualProviderEvidence | null;
  status: "available" | "unavailable";
  version: typeof KNOWLEDGE_VISUAL_ANALYSIS_VERSION;
  warnings: readonly ("analysis_unavailable" | "original_unavailable")[];
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function safeString(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function usage(value: unknown): ModelRunUsage | null {
  if (!record(value) || !onlyKeys(value, [
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "estimatedCostMicros",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens"
  ])) return null;
  const integer = (candidate: unknown) => Number.isSafeInteger(candidate) && Number(candidate) >= 0;
  if (!integer(value.inputTokens) || !integer(value.outputTokens) ||
    !integer(value.reasoningTokens) || !integer(value.totalTokens) ||
    Number(value.totalTokens) < Number(value.inputTokens) + Number(value.outputTokens) ||
    value.cachedInputTokens !== undefined && !integer(value.cachedInputTokens) ||
    value.cacheWriteInputTokens !== undefined && !integer(value.cacheWriteInputTokens) ||
    value.estimatedCostMicros !== undefined && value.estimatedCostMicros !== null &&
      !integer(value.estimatedCostMicros)) return null;
  return {
    ...(value.cachedInputTokens === undefined
      ? {} : { cachedInputTokens: Number(value.cachedInputTokens) }),
    ...(value.cacheWriteInputTokens === undefined
      ? {} : { cacheWriteInputTokens: Number(value.cacheWriteInputTokens) }),
    ...(value.estimatedCostMicros === undefined
      ? {} : {
          estimatedCostMicros: value.estimatedCostMicros === null
            ? null
            : Number(value.estimatedCostMicros)
        }),
    inputTokens: Number(value.inputTokens),
    outputTokens: Number(value.outputTokens),
    reasoningTokens: Number(value.reasoningTokens),
    totalTokens: Number(value.totalTokens)
  };
}

function boundingBox(value: unknown): ParsedBoundingBox | null {
  if (!record(value) || !onlyKeys(value, [
    "bottom", "coordinateOrigin", "left", "page", "right", "top"
  ]) || !Number.isSafeInteger(value.page) || Number(value.page) < 1 ||
    ![value.bottom, value.left, value.right, value.top].every(Number.isFinite) ||
    Number(value.left) > Number(value.right) ||
    value.coordinateOrigin !== "bottom_left" && value.coordinateOrigin !== "top_left" ||
    value.coordinateOrigin === "top_left" && Number(value.bottom) < Number(value.top) ||
    value.coordinateOrigin === "bottom_left" && Number(value.bottom) > Number(value.top)) return null;
  return {
    bottom: Number(value.bottom),
    coordinateOrigin: value.coordinateOrigin,
    left: Number(value.left),
    page: Number(value.page),
    right: Number(value.right),
    top: Number(value.top)
  };
}

/** Strict read-only decoder used by immutable receipts and citation viewer payloads. */
export function decodeKnowledgeVisualAnalysisResult(
  value: unknown
): KnowledgeVisualAnalysisResult | null {
  if (!record(value) || !onlyKeys(value, [
    "assetId", "blockId", "boundingBoxes", "caption", "description", "headingPath",
    "kind", "label", "page", "provider", "status", "version", "warnings"
  ]) || value.version !== KNOWLEDGE_VISUAL_ANALYSIS_VERSION ||
    value.assetId !== null && !safeString(value.assetId) || !safeString(value.blockId) ||
    !Array.isArray(value.boundingBoxes) || value.boundingBoxes.length > MAX_VISUAL_BOXES ||
    value.caption !== null && !safeText(value.caption, 2_000) ||
    value.description !== null && !safeText(value.description, MAX_DESCRIPTION_CHARACTERS) ||
    !Array.isArray(value.headingPath) || value.headingPath.length > 16 ||
    value.headingPath.some((part) => !safeString(part, 256)) ||
    !["chart", "diagram", "image", "table"].includes(String(value.kind)) ||
    !safeString(value.label, MAX_LABEL_CHARACTERS) || !Number.isSafeInteger(value.page) ||
    Number(value.page) < 1 || value.status !== "available" && value.status !== "unavailable" ||
    !Array.isArray(value.warnings) || value.warnings.length > 2 ||
    value.warnings.some((warning) => warning !== "analysis_unavailable" &&
      warning !== "original_unavailable") || new Set(value.warnings).size !== value.warnings.length) {
    return null;
  }
  const boxes = value.boundingBoxes.map(boundingBox);
  if (boxes.some((box) => box === null)) return null;
  let provider: KnowledgeVisualProviderEvidence | null = null;
  if (value.provider !== null) {
    if (!record(value.provider) || !onlyKeys(value.provider, [
      "modelId", "profileRevisionId", "provider", "providerModelId", "usage"
    ]) || !safeString(value.provider.modelId) || !safeString(value.provider.profileRevisionId) ||
      !safeString(value.provider.provider) || !safeString(value.provider.providerModelId)) return null;
    const decodedUsage = usage(value.provider.usage);
    if (!decodedUsage) return null;
    provider = {
      modelId: value.provider.modelId,
      profileRevisionId: value.provider.profileRevisionId,
      provider: value.provider.provider,
      providerModelId: value.provider.providerModelId,
      usage: decodedUsage
    };
  }
  if (value.status === "available"
    ? value.description === null || provider === null || value.warnings.length !== 0
    : value.description !== null || provider !== null ||
      !value.warnings.includes("analysis_unavailable")) return null;
  return Object.freeze({
    assetId: value.assetId as string | null,
    blockId: value.blockId,
    boundingBoxes: Object.freeze(boxes as ParsedBoundingBox[]),
    caption: value.caption as string | null,
    description: value.description as string | null,
    headingPath: Object.freeze([...(value.headingPath as string[])]),
    kind: value.kind as KnowledgeVisualRegionKind,
    label: value.label,
    page: Number(value.page),
    provider: provider ? Object.freeze(provider) : null,
    status: value.status,
    version: KNOWLEDGE_VISUAL_ANALYSIS_VERSION,
    warnings: Object.freeze([...(value.warnings as KnowledgeVisualAnalysisResult["warnings"])])
  });
}
