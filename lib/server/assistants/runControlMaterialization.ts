import type { AssistantRunControls } from "../../contracts/assistants";
import type { ModelParameterControls } from "../../contracts/catalog";
import { validateRunParams } from "../../domain/runParams";

export type AssistantRunParamsResult =
  | { ok: false }
  | { ok: true; params: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

export function assistantRunControlsSupported(
  runControls: AssistantRunControls,
  controls: ModelParameterControls
): boolean {
  return !(
    (runControls.backgroundMode !== undefined && !controls.background.supported) ||
    (runControls.streamMode !== undefined && !controls.stream.supported) ||
    (runControls.maxOutputTokens !== undefined &&
      runControls.maxOutputTokens > controls.maxOutputTokens.maxValue) ||
    (runControls.temperature !== undefined &&
      (!controls.temperature.supported ||
        runControls.temperature < controls.temperature.minValue ||
        runControls.temperature > controls.temperature.maxValue)) ||
    (runControls.reasoningMode !== undefined &&
      !(controls.reasoningMode?.supported === true &&
        controls.reasoningMode.options.includes(runControls.reasoningMode))) ||
    (runControls.reasoningEffort !== undefined &&
      (controls.reasoningEffort.supported
        ? !controls.reasoningEffort.options.includes(runControls.reasoningEffort)
        : runControls.reasoningEffort !== "none"))
  );
}

/**
 * Server-authoritative materialization of an Assistant revision's
 * provider-neutral controls into exact dialect params, shared by send,
 * regeneration, and edited-branch admission. Saved values are used exactly and
 * never clamped, omitted, or substituted: a stored control the current model
 * no longer supports fails closed instead of silently degrading, matching the
 * composer's dialect mapping for supported values.
 */
export function materializeAssistantRunParams(input: {
  baseParams: Record<string, unknown>;
  controls: ModelParameterControls;
  parameterProvider: string;
  runControls: AssistantRunControls;
}): AssistantRunParamsResult {
  const { baseParams, controls, parameterProvider, runControls } = input;

  if (!assistantRunControlsSupported(runControls, controls)) {
    return { ok: false };
  }

  const maxTokens = Math.round(
    runControls.maxOutputTokens ?? controls.maxOutputTokens.defaultValue
  );
  const temperature = runControls.temperature ?? controls.temperature.defaultValue;
  const effort =
    runControls.reasoningEffort ??
    (controls.reasoningEffort.supported ? controls.reasoningEffort.defaultValue : "none");
  const mode = runControls.reasoningMode ?? controls.reasoningMode?.defaultValue;
  const background = runControls.backgroundMode ?? controls.background.defaultValue;
  const stream = runControls.streamMode ?? controls.stream.defaultValue;

  let params: Record<string, unknown>;

  if (parameterProvider === "gemini") {
    params = {
      ...baseParams,
      maxOutputTokens: maxTokens,
      reasoning: {
        ...recordValue(baseParams.reasoning),
        effort
      }
    };
    delete params.maxTokens;
    delete params.max_tokens;
    delete params.max_output_tokens;
    delete params.max_completion_tokens;
    if (controls.stream.supported) {
      params.stream = stream;
    } else {
      delete params.stream;
    }
    delete params.temperature;
  } else if (parameterProvider === "openai") {
    const reasoning: Record<string, unknown> = {
      ...recordValue(baseParams.reasoning),
      effort
    };
    if (controls.reasoningMode?.supported && mode !== undefined) {
      reasoning.mode = mode;
    } else {
      delete reasoning.mode;
    }
    params = {
      ...baseParams,
      maxOutputTokens: maxTokens,
      reasoning,
      temperature
    };
    if (controls.background.supported) {
      params.background = background;
    } else {
      delete params.background;
    }
    if (controls.stream.supported) {
      params.stream = stream;
    } else {
      delete params.stream;
    }
    if (!controls.temperature.supported) {
      delete params.temperature;
    }
  } else if (parameterProvider === "anthropic") {
    params = {
      ...baseParams,
      maxTokens,
      outputConfig: {
        ...recordValue(baseParams.outputConfig),
        effort
      },
      thinking: {
        ...recordValue(baseParams.thinking),
        budgetTokens: 0,
        enabled: controls.reasoningEffort.supported && effort !== "none",
        type: "adaptive"
      }
    };
    if (controls.temperature.supported) {
      params.temperature = temperature;
    } else {
      delete params.temperature;
    }
    delete params.reasoning;
  } else if (parameterProvider === "openrouter") {
    const usesVerbosityEffort = typeof baseParams.verbosity === "string";
    params = {
      ...baseParams,
      maxTokens,
      reasoning: {
        ...recordValue(baseParams.reasoning),
        enabled: controls.reasoningEffort.supported && effort !== "none",
        ...(usesVerbosityEffort || effort === "none" ? {} : { effort })
      }
    };
    if (controls.stream.supported) {
      params.stream = stream;
    } else {
      delete params.stream;
    }
    if (usesVerbosityEffort && effort !== "none") {
      params.verbosity = effort;
    }
    if (controls.temperature.supported) {
      params.temperature = temperature;
    } else {
      delete params.temperature;
    }
  } else {
    params = {
      ...baseParams,
      maxOutputTokens: maxTokens,
      reasoning: {
        effort
      },
      temperature
    };
    if (controls.stream.supported) {
      params.stream = stream;
    }
    if (!controls.temperature.supported) {
      delete params.temperature;
    }
  }

  const validated = validateRunParams({
    controls,
    params,
    provider: parameterProvider
  });
  if (!validated.ok) {
    return { ok: false };
  }

  return { ok: true, params: validated.params };
}
