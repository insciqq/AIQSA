import type {
  Catalog,
  CatalogModel,
  ModelParameterControls,
  ReasoningEffort
} from "@/components/app-shell/types";
import { numberValue } from "@/components/app-shell/shellValues";

export function defaultParameterControls(model?: CatalogModel | null): ModelParameterControls {
  const defaultMax =
    numberValue(model?.defaultParams.maxOutputTokens, 0) ||
    numberValue(model?.defaultParams.maxTokens, 0) ||
    numberValue(model?.defaultParams.max_output_tokens, 1024);

  return (
    model?.parameterControls ?? {
      background: {
        defaultValue: model?.provider === "openai",
        supported: model?.provider === "openai"
      },
      maxOutputTokens: {
        defaultValue: defaultMax,
        maxValue: defaultMax
      },
      reasoningEffort: model?.capabilities.reasoning
        ? {
            defaultValue: "medium",
            options: ["none", "low", "medium", "high"],
            supported: true
          }
        : {
            defaultValue: "none",
            options: ["none"],
            supported: false
          },
      reasoningMode: {
        defaultValue: "standard",
        options: ["standard"],
        supported: false
      },
      stream: {
        defaultValue: Boolean(model?.capabilities.streaming && model.provider !== "openai"),
        supported: false
      },
      temperature: {
        defaultValue: numberValue(model?.defaultParams.temperature, 1),
        maxValue: 2,
        minValue: 0,
        supported: true
      }
    }
  );
}

export function coerceReasoningEffort(
  value: string,
  controls: ModelParameterControls
): ReasoningEffort {
  const options =
    controls.reasoningEffort.options.length > 0
      ? controls.reasoningEffort.options
      : ["none"];

  return options.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : options[0];
}

export function coerceReasoningMode(
  value: string,
  controls: ModelParameterControls
): string {
  const modeControls = controls.reasoningMode;
  const options =
    modeControls && modeControls.options.length > 0
      ? modeControls.options
      : [modeControls?.defaultValue ?? "standard"];

  return options.includes(value) ? value : options[0];
}

export function clampedNumber(
  value: string,
  fallback: number,
  min: number,
  max?: number
): number {
  const parsed = Number(value);
  const next = Number.isFinite(parsed) ? parsed : fallback;
  const floor = Math.max(min, next);

  return typeof max === "number" && Number.isFinite(max)
    ? Math.min(max, floor)
    : floor;
}

export function fallbackCatalogModel(
  catalog: Catalog | null,
  preferred?: { modelId: string; provider: string }
): CatalogModel | undefined {
  if (!catalog) {
    return undefined;
  }

  return (
    (preferred
      ? catalog.models.find(
          (candidate) =>
            candidate.provider === preferred.provider &&
            candidate.modelId === preferred.modelId
        )
      : undefined) ??
    catalog.models.find(
      (candidate) =>
        candidate.provider === catalog.defaults.provider &&
        candidate.modelId === catalog.defaults.modelId
    ) ??
    catalog.models.find((candidate) => candidate.provider !== "fake") ??
    catalog.models[0]
  );
}
