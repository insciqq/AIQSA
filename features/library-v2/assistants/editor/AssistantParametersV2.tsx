"use client";

import {
  draftModelId,
  type AssistantControlsDraft,
  type AssistantEditorView
} from "@/components/assistants/libraryViewContracts";
import type { AssistantRunControlField } from "@/lib/contracts/assistants";
import type { ReactNode } from "react";

function ParameterField({ children, error, help, htmlFor, id, label, range }: Readonly<{
  children: ReactNode;
  error?: string;
  help: string;
  htmlFor?: string;
  id: string;
  label: string;
  range?: string;
}>) {
  return (
    <div className="v2-assistant-parameter" data-invalid={Boolean(error) || undefined}>
      <div className="v2-assistant-parameter-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span id={`${id}-label`}>{label}</span>}
        {range ? <small>{range}</small> : null}
      </div>
      {children}
      <p id={`${id}-help`}>{help}</p>
      {error ? <p className="v2-assistant-field-error" id={`${id}-error`}>{error}</p> : null}
    </div>
  );
}

function describedBy(id: string, error?: string) {
  return error ? `${id}-help ${id}-error` : `${id}-help`;
}

function DefaultInput({ error, id, inputMode, onChange, placeholder, value }: Readonly<{
  error?: string;
  id: string;
  inputMode: "decimal" | "numeric";
  onChange(value: string): void;
  placeholder: string;
  value: string;
}>) {
  return (
    <span className="v2-assistant-parameter-input">
      <input
        aria-describedby={describedBy(id, error)}
        aria-invalid={Boolean(error) || undefined}
        id={id}
        inputMode={inputMode}
        placeholder={placeholder}
        type="text"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {value ? <button className="v2-focusable" type="button" onClick={() => onChange("")}>Use default</button> : null}
    </span>
  );
}

function DefaultSelect({ defaultLabel, error, id, onChange, options, value }: Readonly<{
  defaultLabel: string;
  error?: string;
  id: string;
  onChange(value: string): void;
  options: readonly string[];
  value: string;
}>) {
  return (
    <select
      aria-describedby={describedBy(id, error)}
      aria-invalid={Boolean(error) || undefined}
      id={id}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      <option value="">Not set · model default {defaultLabel}</option>
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  );
}

/** Not set, On or Off: three fixed choices. */
function TriState({ error, id, onChange, value }: Readonly<{
  error?: string;
  id: string;
  onChange(value: boolean | null): void;
  value: boolean | null;
}>) {
  return (
    <div
      aria-describedby={describedBy(id, error)}
      aria-labelledby={`${id}-label`}
      className="v2-assistant-tristate"
      role="group"
    >
      {([[null, "Not set"], [true, "On"], [false, "Off"]] as const).map(([candidate, text]) => (
        <button
          aria-pressed={value === candidate}
          className="v2-focusable"
          key={text}
          type="button"
          onClick={() => onChange(candidate)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * The Reasoning & parameters row: a partial set for the Assistant's own
 * model. An unset field uses each person's saved value for that model.
 */
export function AssistantParametersV2({ editor }: Readonly<{ editor: AssistantEditorView }>) {
  const rows = editor.draft.rows;
  const modelId = draftModelId(rows);
  const model = modelId ? editor.options.models.find((item) => item.id === modelId) ?? null : null;
  if (rows.model.value.mode === "inherit") {
    return <p className="v2-assistant-setup-note">Choose a model to set its parameters</p>;
  }
  if (!model) {
    return <p className="v2-assistant-setup-note">This model is not in your catalog. Choose another model to set its parameters.</p>;
  }
  const controls = model.controls;
  const value = rows.controls.value;
  const errors = editor.errors?.fields ?? {};
  const set = <Field extends AssistantRunControlField>(field: Field, next: AssistantControlsDraft[Field]) =>
    editor.onRowChange("controls", { value: { ...value, [field]: next } });
  return (
    <div className="v2-assistant-parameters">
      <p className="v2-assistant-setup-note">Leave a value unset to use each person&apos;s saved value for {model.label}.</p>
      {controls.reasoningEffort.supported ? (
        <ParameterField error={errors.reasoningEffort} help="Use a higher effort only when questions warrant more work." htmlFor="assistant-editor-reasoning-effort" id="assistant-editor-reasoning-effort" label="Reasoning effort">
          <DefaultSelect
            defaultLabel={controls.reasoningEffort.defaultValue}
            error={errors.reasoningEffort}
            id="assistant-editor-reasoning-effort"
            options={controls.reasoningEffort.options}
            value={value.reasoningEffort}
            onChange={(next) => set("reasoningEffort", next)}
          />
        </ParameterField>
      ) : null}
      {controls.reasoningMode?.supported ? (
        <ParameterField error={errors.reasoningMode} help="How this model approaches harder questions." htmlFor="assistant-editor-reasoning-mode" id="assistant-editor-reasoning-mode" label="Reasoning mode">
          <DefaultSelect
            defaultLabel={controls.reasoningMode.defaultValue}
            error={errors.reasoningMode}
            id="assistant-editor-reasoning-mode"
            options={controls.reasoningMode.options}
            value={value.reasoningMode}
            onChange={(next) => set("reasoningMode", next)}
          />
        </ParameterField>
      ) : null}
      {controls.temperature.supported ? (
        <ParameterField error={errors.temperature} help="Higher is more varied; lower is more repeatable." htmlFor="assistant-editor-temperature" id="assistant-editor-temperature" label="Temperature" range={`${controls.temperature.minValue} – ${controls.temperature.maxValue}`}>
          <DefaultInput
            error={errors.temperature}
            id="assistant-editor-temperature"
            inputMode="decimal"
            placeholder={String(controls.temperature.defaultValue)}
            value={value.temperature}
            onChange={(next) => set("temperature", next)}
          />
        </ParameterField>
      ) : null}
      <ParameterField error={errors.maxOutputTokens} help="The answer stops when it reaches this length." htmlFor="assistant-editor-max-output" id="assistant-editor-max-output" label="Max answer length" range="tokens">
        <DefaultInput
          error={errors.maxOutputTokens}
          id="assistant-editor-max-output"
          inputMode="numeric"
          placeholder={String(controls.maxOutputTokens.defaultValue)}
          value={value.maxOutputTokens}
          onChange={(next) => set("maxOutputTokens", next)}
        />
      </ParameterField>
      {controls.stream.supported ? (
        <ParameterField error={errors.streamMode} help="On shows the answer while it is written." id="assistant-editor-stream" label="Stream the answer">
          <TriState error={errors.streamMode} id="assistant-editor-stream" value={value.streamMode} onChange={(next) => set("streamMode", next)} />
        </ParameterField>
      ) : null}
      {controls.background.supported ? (
        <ParameterField error={errors.backgroundMode} help="Background runs keep working after the chat closes." id="assistant-editor-background" label="Run in the background">
          <TriState error={errors.backgroundMode} id="assistant-editor-background" value={value.backgroundMode} onChange={(next) => set("backgroundMode", next)} />
        </ParameterField>
      ) : null}
    </div>
  );
}
