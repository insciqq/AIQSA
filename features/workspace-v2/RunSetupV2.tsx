"use client";

import type { ShellComposerView } from "@/components/app-shell/powerAppShellV2Contracts";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
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
>;

function RunSetupSwitchV2({
  checked,
  label,
  stateLabels = ["On", "Off"],
  onToggle
}: Readonly<{
  checked: boolean;
  label: string;
  stateLabels?: readonly [string, string];
  onToggle(): void;
}>) {
  return (
    <button aria-checked={checked} role="switch" type="button" onClick={onToggle}>
      <span>{label}</span>
      <span className="v2-run-setup-switch-state">
        <strong>{checked ? stateLabels[0] : stateLabels[1]}</strong>
        <span aria-hidden="true" className="v2-run-setup-switch-track" />
      </span>
    </button>
  );
}
export function RunSetupV2({ composer, onClose }: Readonly<{
  composer: RunSetupComposerV2;
  onClose(): void;
}>) {
  const controls = composer.currentParameterControls;
  const [defaultsFeedback, setDefaultsFeedback] = useState<string | null>(null);
  const {
    dialogRef,
    initialFocusRef,
    onDialogKeyDown,
    portalReady
  } = useModalLayerV2({ onClose });

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
          {controls.temperature.supported ? (
            <label>
              <span>Temperature</span>
              <input
                max={controls.temperature.maxValue}
                min={controls.temperature.minValue}
                step="0.1"
                type="number"
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
              value={composer.maxOutputTokens}
              onChange={(event) => composer.changeMaxOutputTokens(event.target.value)}
            />
          </label>
          {controls.reasoningEffort.supported ? (
            <label>
              <span>Reasoning effort</span>
              <select
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
                value={composer.reasoningMode}
                onChange={(event) => composer.changeReasoningMode(event.target.value)}
              >
                {controls.reasoningMode.options.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            <span>Search orchestration</span>
            <select
              aria-label="Search orchestration"
              value={composer.searchPlanMode}
              onChange={(event) => composer.selectSearchPlan(
                composer.selectedSearchOptionIds,
                event.target.value === "model_choice" ? "model_choice" : "all_selected"
              )}
            >
              <option value="all_selected">All selected per search</option>
              <option value="model_choice">Model chooses</option>
            </select>
          </label>
          <div className="v2-run-setup-switches">
            {controls.stream.supported ? (
              <RunSetupSwitchV2
                checked={composer.streamMode}
                label="Streaming"
                onToggle={() => composer.changeStreamMode(!composer.streamMode)}
              />
            ) : null}
            {controls.background.supported ? (
              <RunSetupSwitchV2
                checked={composer.backgroundMode}
                label="Background"
                onToggle={() => composer.changeBackgroundMode(!composer.backgroundMode)}
              />
            ) : null}
          </div>
          <div className="v2-run-setup-defaults">
            {composer.useOrganizationModelDefault ? (
              <UiV2Button onClick={() => {
                composer.useOrganizationModelDefault?.();
                setDefaultsFeedback("Organization model default applied.");
              }}>
                Use organization model default
              </UiV2Button>
            ) : null}
            <UiV2Button onClick={() => {
              composer.useOrganizationSearchDefault();
              setDefaultsFeedback("Organization Search default applied.");
            }}>
              Use organization Search default
            </UiV2Button>
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
