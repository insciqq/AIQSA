"use client";

import type { AssistantEditorView } from "@/components/assistants/libraryViewContracts";
import { UiV2Icon } from "@/components/ui-v2";
import type { AssistantRunControlField } from "@/lib/contracts/assistants";
import type { ReactNode } from "react";

function FieldShellV2({
  children,
  error,
  help,
  htmlFor,
  label,
  range
}: Readonly<{
  children: ReactNode;
  error?: string;
  help: string;
  htmlFor?: string;
  label: string;
  range?: string;
}>) {
  return (
    <div className="v2-assistant-advanced-field" data-invalid={Boolean(error) || undefined}>
      <div className="v2-assistant-advanced-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {range ? <small>{range}</small> : null}
      </div>
      {children}
      <p>{help}</p>
      {error ? <p className="v2-assistant-field-error" role="alert">{error}</p> : null}
    </div>
  );
}

function DefaultSlotInputV2({
  disabled,
  error,
  id,
  inputMode,
  onChange,
  placeholder,
  value
}: Readonly<{
  disabled: boolean;
  error?: string;
  id: string;
  inputMode: "decimal" | "numeric";
  onChange(value: string): void;
  placeholder: string;
  value: string;
}>) {
  return (
    <span className="v2-assistant-default-input">
      <input
        aria-invalid={Boolean(error) || undefined}
        disabled={disabled}
        id={id}
        inputMode={inputMode}
        placeholder={placeholder}
        type="text"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {!value ? <small>model default</small> : <button className="v2-focusable" type="button" onClick={() => onChange("")}>Use default</button>}
    </span>
  );
}

function DefaultSelectV2({
  defaultLabel,
  disabled,
  error,
  id,
  onChange,
  options,
  value
}: Readonly<{
  defaultLabel: string;
  disabled: boolean;
  error?: string;
  id: string;
  onChange(value: string): void;
  options: readonly string[];
  value: string;
}>) {
  return (
    <select
      aria-invalid={Boolean(error) || undefined}
      disabled={disabled}
      id={id}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      <option value="">{defaultLabel} · model default</option>
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  );
}

function TriStateControlV2({
  disabled,
  error,
  label,
  onChange,
  value
}: Readonly<{
  disabled: boolean;
  error?: string;
  label: string;
  onChange(value: boolean | null): void;
  value: boolean | null;
}>) {
  return (
    <div aria-label={label} className="v2-assistant-tristate" data-invalid={Boolean(error) || undefined} role="group">
      {([
        [null, "Model default"],
        [true, "On"],
        [false, "Off"]
      ] as const).map(([candidate, text]) => (
        <button
          aria-pressed={value === candidate}
          className="v2-focusable"
          disabled={disabled}
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

export function AssistantAdvancedControlsV2({
  editor,
  locked
}: Readonly<{
  editor: AssistantEditorView;
  locked: boolean;
}>) {
  const { draft, fieldErrors } = editor;
  const model = editor.options.models.find((item) => item.id === draft.providerModelId) ?? null;
  const controls = model?.controls ?? null;
  const supportedValues: readonly [AssistantRunControlField, unknown][] = [
    ["temperature", draft.temperature],
    ["maxOutputTokens", draft.maxOutputTokens],
    ["reasoningEffort", draft.reasoningEffort],
    ["reasoningMode", draft.reasoningMode],
    ["streamMode", draft.streamMode],
    ["backgroundMode", draft.backgroundMode]
  ];
  const allDefaults = supportedValues.every(([, value]) => value === "" || value === null);

  return (
    <details className="v2-assistant-disclosure v2-assistant-advanced" data-testid="assistant-advanced-settings">
      <summary className="v2-focusable">
        <UiV2Icon name="chevron-right" />
        <span>
          <strong>Advanced model settings</strong>
          <small>Temperature, answer length and reasoning. Left alone, the assistant uses the model&apos;s defaults.</small>
        </span>
      </summary>
      <div className="v2-assistant-advanced-body">
        {!model || !controls ? (
          <p className="v2-assistant-field-message">Choose a model to see the controls it supports.</p>
        ) : (
          <>
            {allDefaults ? (
              <p className="v2-assistant-default-note">
                <UiV2Icon name="check" />
                <span>Using the model&apos;s own defaults. Change a value only if you know why.</span>
              </p>
            ) : null}
            <div className="v2-assistant-advanced-grid">
              {controls.temperature.supported ? (
                <FieldShellV2
                  error={fieldErrors?.temperature}
                  help="Higher is more varied; lower is more repeatable."
                  htmlFor="assistant-editor-temperature"
                  label="Temperature"
                  range={`${controls.temperature.minValue} – ${controls.temperature.maxValue}`}
                >
                  <DefaultSlotInputV2
                    disabled={locked}
                    error={fieldErrors?.temperature}
                    id="assistant-editor-temperature"
                    inputMode="decimal"
                    placeholder={String(controls.temperature.defaultValue)}
                    value={draft.temperature}
                    onChange={(temperature) => editor.onChange({ temperature })}
                  />
                </FieldShellV2>
              ) : null}
              <FieldShellV2
                error={fieldErrors?.maxOutputTokens}
                help="The answer stops when it reaches this length."
                htmlFor="assistant-editor-max-output"
                label="Max answer length"
                range="model limit"
              >
                <DefaultSlotInputV2
                  disabled={locked}
                  error={fieldErrors?.maxOutputTokens}
                  id="assistant-editor-max-output"
                  inputMode="numeric"
                  placeholder={`${controls.maxOutputTokens.defaultValue} tokens`}
                  value={draft.maxOutputTokens}
                  onChange={(maxOutputTokens) => editor.onChange({ maxOutputTokens })}
                />
              </FieldShellV2>
              {controls.reasoningEffort.supported ? (
                <FieldShellV2
                  error={fieldErrors?.reasoningEffort}
                  help="Use a higher effort only when the question warrants more work."
                  htmlFor="assistant-editor-reasoning-effort"
                  label="Reasoning effort"
                >
                  <DefaultSelectV2
                    defaultLabel={controls.reasoningEffort.defaultValue}
                    disabled={locked}
                    error={fieldErrors?.reasoningEffort}
                    id="assistant-editor-reasoning-effort"
                    options={controls.reasoningEffort.options}
                    value={draft.reasoningEffort}
                    onChange={(reasoningEffort) => editor.onChange({ reasoningEffort })}
                  />
                </FieldShellV2>
              ) : null}
              {controls.reasoningMode?.supported ? (
                <FieldShellV2
                  error={fieldErrors?.reasoningMode}
                  help="Choose how this model approaches harder questions."
                  htmlFor="assistant-editor-reasoning-mode"
                  label="Reasoning mode"
                >
                  <DefaultSelectV2
                    defaultLabel={controls.reasoningMode.defaultValue}
                    disabled={locked}
                    error={fieldErrors?.reasoningMode}
                    id="assistant-editor-reasoning-mode"
                    options={controls.reasoningMode.options}
                    value={draft.reasoningMode}
                    onChange={(reasoningMode) => editor.onChange({ reasoningMode })}
                  />
                </FieldShellV2>
              ) : null}
              {controls.stream.supported ? (
                <FieldShellV2
                  error={fieldErrors?.streamMode}
                  help="On shows the answer while it is written; Off waits until it is finished."
                  label="Stream the answer"
                >
                  <TriStateControlV2
                    disabled={locked}
                    error={fieldErrors?.streamMode}
                    label="Stream the answer"
                    value={draft.streamMode}
                    onChange={(streamMode) => editor.onChange({ streamMode })}
                  />
                </FieldShellV2>
              ) : null}
              {controls.background.supported ? (
                <FieldShellV2
                  error={fieldErrors?.backgroundMode}
                  help="Background runs can keep working after you close the chat."
                  label="Run in the background"
                >
                  <TriStateControlV2
                    disabled={locked}
                    error={fieldErrors?.backgroundMode}
                    label="Run in the background"
                    value={draft.backgroundMode}
                    onChange={(backgroundMode) => editor.onChange({ backgroundMode })}
                  />
                </FieldShellV2>
              ) : null}
            </div>
          </>
        )}
      </div>
    </details>
  );
}
