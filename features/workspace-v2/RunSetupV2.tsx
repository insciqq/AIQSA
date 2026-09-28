"use client";

import type { ShellComposerView } from "@/components/app-shell/powerAppShellV2Contracts";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
import {
  AssistantRowNoticeV2,
  assistantRowNoticeText,
  assistantRowProvenance,
  boundComposerAssistantV2,
  type ComposerV2Assistant
} from "@/features/composer-v2/AssistantRowProvenanceV2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { useState } from "react";
import { createPortal } from "react-dom";

export type RunSetupComposerV2 = Pick<
  ShellComposerView,
  | "backgroundMode"
  | "changeBackgroundMode"
  | "changeMaxOutputTokens"
  | "changeReasoningEffort"
  | "changeReasoningMode"
  | "changeStreamMode"
  | "changeTemperature"
  | "currentModel"
  | "currentParameterControls"
  | "maxOutputTokens"
  | "reasoningEffort"
  | "reasoningMode"
  | "searchPlanMode"
  | "selectSearchPlan"
  | "selectedSearchOptionIds"
  | "streamMode"
  | "temperature"
  | "useOrganizationModelDefault"
  | "useOrganizationSearchDefault"
> & {
  /** The chat's Assistant; its parameters row governs the fields while its model is in use. */
  assistant?: ComposerV2Assistant | null;
};

function RunSetupSwitchV2({
  checked,
  disabled = false,
  label,
  stateLabels = ["On", "Off"],
  onToggle
}: Readonly<{
  checked: boolean;
  disabled?: boolean;
  label: string;
  stateLabels?: readonly [string, string];
  onToggle(): void;
}>) {
  return (
    <button aria-checked={checked} disabled={disabled} role="switch" type="button" onClick={onToggle}>
      <span>{label}</span>
      <span className="v2-run-setup-switch-state">
        <strong>{checked ? stateLabels[0] : stateLabels[1]}</strong>
        <span aria-hidden="true" className="v2-run-setup-switch-track" />
      </span>
    </button>
  );
}
export function RunSetupV2({ composer, onClose, restoreFocus }: Readonly<{
  composer: RunSetupComposerV2;
  onClose(): void;
  /** Where focus goes on close when the control that opened it is gone. */
  restoreFocus?(): HTMLElement | null;
}>) {
  const controls = composer.currentParameterControls;
  const [defaultsFeedback, setDefaultsFeedback] = useState<string | null>(null);
  // The Assistant's parameters belong to its own model: with another
  // model the fields are the user's defaults for it and always editable.
  const assistant = boundComposerAssistantV2(composer.assistant);
  const assistantModel = assistant?.rows.model.assistantValue;
  const otherModel = Boolean(assistant && composer.currentModel && assistantModel?.mode === "model" &&
    assistantModel.modelId !== composer.currentModel.modelId);
  const provenance = otherModel ? null : assistantRowProvenance(assistant, "controls");
  const fixed = provenance?.kind === "fixed";
  const modelFixed = assistant?.rows.model.policy === "fixed";
  // Parameters the Assistant leaves to the user's defaults read as the
  // user's own until changed for this chat; then they reset like any row.
  const notice = provenance?.kind === "adjustable"
    ? assistantRowNoticeText(provenance)
    : provenance?.kind === "own" && provenance.changed ? "Changed for this chat" : null;
  const {
    dialogRef,
    initialFocusRef,
    onDialogKeyDown,
    portalReady
  } = useModalLayerV2({ onClose, restoreFocus });

  if (!portalReady) return null;

  return createPortal(
    <div className="v2-run-setup-scrim" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        aria-label="Model parameters"
        aria-modal="true"
        className="v2-run-setup"
        onKeyDown={onDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <div>
            <small>Applies to your next message</small>
            <h2>Model parameters</h2>
          </div>
          <UiV2IconButton
            icon="close"
            label="Close parameters"
            onClick={onClose}
            ref={initialFocusRef}
          />
        </header>
        <div className="v2-run-setup-body">
          <p className="v2-run-setup-current" data-testid="run-setup-current-model">
            Current model:{" "}
            <strong>{composer.currentModel?.displayName ?? "Not selected"}</strong>
          </p>
          {fixed ? <AssistantRowNoticeV2 kind="fixed" text="Fixed by the Assistant" /> : null}
          {notice && provenance ? (
            <AssistantRowNoticeV2
              kind="adjustable"
              text={notice}
              action={provenance.changed ? (
                <button
                  className="v2-composer-provenance-action v2-focusable"
                  type="button"
                  onClick={() => composer.assistant?.resetRow("controls")}
                >
                  Reset to Assistant
                </button>
              ) : <span className="v2-composer-provenance-state">unchanged</span>}
            />
          ) : null}
          {otherModel && composer.currentModel ? (
            <p className="v2-run-setup-current" data-testid="run-setup-own-defaults">
              Parameters: your defaults for {composer.currentModel.displayName}
            </p>
          ) : null}
          {controls.temperature.supported ? (
            <label>
              <span>Temperature</span>
              <input
                max={controls.temperature.maxValue}
                min={controls.temperature.minValue}
                step="0.1"
                type="number"
                disabled={fixed}
                value={composer.temperature}
                onChange={(event) => composer.changeTemperature(event.target.value)}
              />
            </label>
          ) : null}
          <label>
            <span>Max output tokens</span>
            <input
              max={controls.maxOutputTokens.maxValue}
              min="1"
              step="1"
              type="number"
              disabled={fixed}
              value={composer.maxOutputTokens}
              onChange={(event) => composer.changeMaxOutputTokens(event.target.value)}
            />
          </label>
          {controls.reasoningEffort.supported ? (
            <label>
              <span>Reasoning effort</span>
              <select
                disabled={fixed}
                value={composer.reasoningEffort}
                onChange={(event) => composer.changeReasoningEffort(event.target.value)}
              >
                {controls.reasoningEffort.options.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
          ) : null}
          {controls.reasoningMode?.supported ? (
            <label>
              <span>Reasoning mode</span>
              <select
                disabled={fixed}
                value={composer.reasoningMode}
                onChange={(event) => composer.changeReasoningMode(event.target.value)}
              >
                {controls.reasoningMode.options.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="v2-run-setup-switches">
            {controls.stream.supported ? (
              <RunSetupSwitchV2
                checked={composer.streamMode}
                disabled={fixed}
                label="Streaming"
                onToggle={() => composer.changeStreamMode(!composer.streamMode)}
              />
            ) : null}
            {controls.background.supported ? (
              <RunSetupSwitchV2
                checked={composer.backgroundMode}
                disabled={fixed}
                label="Background"
                onToggle={() => composer.changeBackgroundMode(!composer.backgroundMode)}
              />
            ) : null}
          </div>
          <div className="v2-run-setup-defaults">
            <UiV2Button disabled={fixed} onClick={() => {
              composer.changeMaxOutputTokens(String(controls.maxOutputTokens.defaultValue));
              if (controls.temperature.supported) composer.changeTemperature(String(controls.temperature.defaultValue));
              setDefaultsFeedback("Output settings reset to this model’s defaults.");
            }}>
              Reset output settings
            </UiV2Button>
            {composer.useOrganizationModelDefault ? (
              <UiV2Button disabled={modelFixed} onClick={() => {
                composer.useOrganizationModelDefault?.();
                setDefaultsFeedback("Organization model default applied.");
              }}>
                Use organization model default
              </UiV2Button>
            ) : null}
            {defaultsFeedback ? (
              <p
                className="v2-run-setup-feedback"
                data-testid="run-setup-defaults-feedback"
                role="status"
              >
                {defaultsFeedback}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </div>,
    document.body
  );
}
