import { ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH } from "../contracts/assistants";
import { ANSWER_RULES_MAX_LENGTH, RESPONSE_REMINDER_MAX_LENGTH, SYSTEM_INSTRUCTIONS_MAX_LENGTH,
  type InstructionPresetDraft } from "../contracts/instructionPresets";
import { renderLocalPromptTemplate, validateIanaTimeZone } from "./promptTemplates";

/** Render once at admission. Recovery uses this exact private text, never a live clock. */
export function renderInstructionPreset(
  preset: Pick<InstructionPresetDraft, "systemInstructions" | "responseReminder" | "answerRules">,
  context: { now: Date; timeZone?: unknown }
): { personalInstructions: string; responseReminder: string; overridesAnswerRules: boolean } | null {
  const options = { now: context.now, locale: "en-US", timeZone: validateIanaTimeZone(context.timeZone) ?? "UTC" };
  const system = renderLocalPromptTemplate(preset.systemInstructions, options);
  const reminder = renderLocalPromptTemplate(preset.responseReminder, options);
  const rules = preset.answerRules == null ? null : renderLocalPromptTemplate(preset.answerRules, options);
  if (system.length > SYSTEM_INSTRUCTIONS_MAX_LENGTH || reminder.length > RESPONSE_REMINDER_MAX_LENGTH ||
    rules !== null && rules.length > ANSWER_RULES_MAX_LENGTH) return null;
  return {
    personalInstructions: [system, rules ? `Answer rules:\n${rules}` : ""].filter(Boolean).join("\n\n"),
    responseReminder: reminder,
    overridesAnswerRules: rules !== null
  };
}

/**
 * Renders an Assistant's own texts with the preset variables once at admission;
 * limits apply after substitution. Blank answer rules count as absent, so the
 * caller keeps the built-in contract instead of sending no answer rules.
 */
export function renderAssistantInstructions(
  assistant: Readonly<{ systemPrompt: string; answerRules?: string | null; responseReminder?: string }>,
  context: { now: Date; timeZone?: unknown }
): { systemPrompt: string; answerRules: string | null; responseReminder: string } | null {
  const options = { now: context.now, locale: "en-US", timeZone: validateIanaTimeZone(context.timeZone) ?? "UTC" };
  const system = renderLocalPromptTemplate(assistant.systemPrompt, options);
  const reminder = renderLocalPromptTemplate(assistant.responseReminder ?? "", options);
  const rules = assistant.answerRules?.trim() ? renderLocalPromptTemplate(assistant.answerRules, options) : null;
  if (system.length > ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH || reminder.length > RESPONSE_REMINDER_MAX_LENGTH ||
    rules !== null && rules.length > ANSWER_RULES_MAX_LENGTH) return null;
  return { systemPrompt: system, answerRules: rules, responseReminder: reminder };
}
