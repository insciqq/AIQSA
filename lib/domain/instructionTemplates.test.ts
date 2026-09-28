import { describe, expect, it } from "vitest";
import { ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH } from "../contracts/assistants";
import { ANSWER_RULES_MAX_LENGTH, RESPONSE_REMINDER_MAX_LENGTH } from "../contracts/instructionPresets";
import { renderAssistantInstructions, renderInstructionPreset } from "./instructionTemplates";

const context = { now: new Date("2026-06-07T23:34:00Z"), timeZone: "Europe/Moscow" };
describe("personal instruction templates", () => {
  it("uses one clock/zone in instructions, reminders and replacement answer rules", () => {
    const preset = { systemInstructions: "Date: {local_date}. Literal {user}.", responseReminder: "At {local_time}.", answerRules: "As of {local_date}." };
    expect(renderInstructionPreset(preset, context)).toEqual({
      personalInstructions: "Date: June 8, 2026. Literal {user}.\n\nAnswer rules:\nAs of June 8, 2026.",
      responseReminder: "At 02:34 AM GMT+3.", overridesAnswerRules: true
    });
    expect(preset.systemInstructions).toContain("{local_date}");
  });
  it("distinguishes inherited rules from an explicitly empty override and falls back to UTC", () => {
    const preset = { systemInstructions: "{local_date}", responseReminder: "" };
    expect(renderInstructionPreset(preset, { ...context, timeZone: "invalid" })).toEqual({
      personalInstructions: "June 7, 2026", responseReminder: "", overridesAnswerRules: false
    });
    expect(renderInstructionPreset({ ...preset, answerRules: "" }, context)?.overridesAnswerRules).toBe(true);
    expect(renderInstructionPreset({ ...preset, answerRules: null }, context)?.overridesAnswerRules).toBe(false);
  });
  it.each(["systemInstructions", "responseReminder", "answerRules"] as const)("rejects %s that exceeds its limit after expansion", field => {
    expect(renderInstructionPreset({ systemInstructions: "", responseReminder: "", [field]: "{local_date}".repeat(field === "systemInstructions" ? 2600 : 330) },
      { ...context, now: new Date("2026-09-23T12:00:00Z") }) === null).toBe(true);
  });
});

describe("assistant instruction templates", () => {
  it("renders instructions, answer rules and reminder with one clock and zone", () => {
    const assistant = { systemPrompt: "Date: {local_date}. Literal {user}.", responseReminder: "At {local_time}.",
      answerRules: "As of {local_date}." };
    expect(renderAssistantInstructions(assistant, context)).toEqual({
      systemPrompt: "Date: June 8, 2026. Literal {user}.", answerRules: "As of June 8, 2026.", responseReminder: "At 02:34 AM GMT+3."
    });
    expect(assistant.systemPrompt).toContain("{local_date}");
  });
  it.each([null, undefined, "", " \n "])("treats missing or blank answer rules (%j) as absent and falls back to UTC", answerRules => {
    expect(renderAssistantInstructions({ systemPrompt: "{local_date}", answerRules }, { ...context, timeZone: "invalid" }))
      .toEqual({ systemPrompt: "June 7, 2026", answerRules: null, responseReminder: "" });
  });
  it.each([
    ["systemPrompt", ASSISTANT_SYSTEM_PROMPT_MAX_LENGTH],
    ["responseReminder", RESPONSE_REMINDER_MAX_LENGTH],
    ["answerRules", ANSWER_RULES_MAX_LENGTH]
  ] as const)("limits %s after expansion", (field, limit) => {
    const now = new Date("2026-09-23T12:00:00Z");
    // "{local_date}" (12 characters) renders as "September 23, 2026" (18).
    expect(renderAssistantInstructions({ systemPrompt: "", [field]: "x".repeat(limit) }, { now })).not.toBeNull();
    expect(renderAssistantInstructions({ systemPrompt: "", [field]: "{local_date}".repeat(Math.floor(limit / 12)) }, { now }))
      .toBeNull();
  });
});
