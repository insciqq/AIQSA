"use client";

import type { AssistantNewAssistantView } from "@/components/assistants/libraryViewContracts";
import { UiV2Button, UiV2Icon, type UiV2IconName } from "@/components/ui-v2";
import { UiV2Sheet } from "@/components/ui-v2/SheetV2";
import { useId, useState, type FormEvent } from "react";
import { ASSISTANT_TEMPLATES } from "./assistantTemplates";
import "./assistant-editor.css";

type StartChoice = Readonly<{ description: string; icon: UiV2IconName; id: string; name: string }>;

const BLANK: StartChoice = {
  description: "Only a name. Your Chat defaults fill the rest.",
  icon: "plus",
  id: "blank",
  name: "Blank"
};

const FROM_CURRENT_CHAT: StartChoice = {
  description: "Copies the model, search, tools, Knowledge and Skills of the open chat as adjustable starting values.",
  icon: "chat",
  id: "current-chat",
  name: "From current chat"
};

const choices: readonly StartChoice[] = [
  BLANK,
  FROM_CURRENT_CHAT,
  ...ASSISTANT_TEMPLATES.map((template) => ({
    description: template.prefill.description,
    icon: template.icon,
    id: template.id,
    name: template.prefill.name
  }))
];

/**
 * "New assistant": Blank, the open chat's setup, or a built-in template.
 * Choosing only fills the editor; nothing is saved until Create.
 */
export function NewAssistantSheetV2({ disabled = false, view }: Readonly<{
  disabled?: boolean;
  view: AssistantNewAssistantView;
}>) {
  const formId = useId();
  const [choice, setChoice] = useState(BLANK.id);
  const close = () => {
    setChoice(BLANK.id);
    view.onClose();
  };
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (disabled) return;
    setChoice(BLANK.id);
    if (choice === BLANK.id) {
      view.onBlank();
      return;
    }
    if (choice === FROM_CURRENT_CHAT.id) {
      view.onFromCurrentChat();
      return;
    }
    const template = ASSISTANT_TEMPLATES.find((candidate) => candidate.id === choice);
    if (!template) return;
    view.onTemplate(
      { ...template.prefill, starterPrompts: [...template.prefill.starterPrompts] },
      template.expandedRow ? { expandedRow: template.expandedRow } : undefined
    );
  };
  return (
    <UiV2Sheet
      description="Start from a template or from your current chat. Nothing is saved until you press Create."
      footer={(
        <>
          <UiV2Button onClick={close}>Cancel</UiV2Button>
          <UiV2Button disabled={disabled} form={formId} tone="primary" type="submit">Continue</UiV2Button>
        </>
      )}
      open={view.open}
      testId="assistant-new-sheet"
      title="New assistant"
      width="wide"
      onClose={close}
    >
      <form className="v2-assistant-new" id={formId} onSubmit={submit}>
        <fieldset>
          <legend className="v2-sr-only">Start from</legend>
          <div className="v2-assistant-new-choices">
            {choices.map((option) => (
              <label className="v2-assistant-new-choice" data-selected={option.id === choice || undefined} key={option.id}>
                <input
                  aria-describedby={`${formId}-${option.id}`}
                  aria-labelledby={`${formId}-${option.id}-name`}
                  checked={option.id === choice}
                  className="v2-sr-only"
                  name={`${formId}-choice`}
                  type="radio"
                  value={option.id}
                  onChange={() => setChoice(option.id)}
                />
                <span className="v2-assistant-new-choice-title">
                  <UiV2Icon name={option.icon} />
                  <span id={`${formId}-${option.id}-name`}>{option.name}</span>
                </span>
                <small id={`${formId}-${option.id}`}>{option.description}</small>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="v2-assistant-new-note">
          Templates are built into AIQSA. They set the name, description, instructions and starters; no models, tools or Knowledge.
        </p>
      </form>
    </UiV2Sheet>
  );
}
