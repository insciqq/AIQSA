import { RESEARCH_SOURCE_CLASSES, RESEARCH_STANDINGS, START_RESEARCH_TOOL_NAME, SUBMIT_RESEARCH_DRAFT_TOOL_NAME } from "../../contracts/research";
import type { RunTool } from "./types";

/**
 * The research method's two tools (operator decisions 2026-11-01): the model
 * starts research when the user's goal is a thorough result, and hands in its
 * report as a draft. Both ride on every request of a run that offers research,
 * so the tool list stays the same across a chat's turns (provider prompt
 * caches); the draft call is refused until research started. They are the main
 * agent's only, added beside the sub-agent tools (`lib/server/engine/execution.ts`),
 * and a run reserves the draft call outside its budgets once research started
 * (`lib/server/tools/reservedToolCall.ts` is the pattern; `lib/server/research/run.ts` the owner).
 */
export { START_RESEARCH_TOOL_NAME, SUBMIT_RESEARCH_DRAFT_TOOL_NAME };

const sourceClass = { description: "primary_official: the maker, the regulator, official documents. independent_tests: labs, independent " +
  "reviews and measurements. owner_reviews: what owners and users report, complaints included. action_channel: where the user will " +
  "buy or act, with its current prices, stock and terms.", enum: [...RESEARCH_SOURCE_CLASSES], type: "string" };

export const startResearchTool: RunTool = {
  capability: "session",
  description: "Call this first, before any search, when the user asks to research, analyze, compare for a decision or search carefully " +
    "(for example \"проанализируй\", \"глубокий анализ\", \"проведи исследование\", \"поищи хорошо\"). It starts the research method: it takes longer, costs more, runs parallel " +
    "researchers and the server checks the report before the user sees it. Give the goal, split it into questions and assign each " +
    "question its source classes up front; every class goes to a question or into skipped_source_classes with the reason it does not " +
    "apply. The user sees the questions as the plan. Result: how to run the research. Not for simple questions or quick lookups.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      goal: { description: "What the user wants to decide or know, in one or two sentences.", type: "string" },
      questions: {
        description: "The questions that together answer the goal, each small enough for one researcher.",
        items: {
          additionalProperties: false,
          properties: {
            question: { type: "string" },
            sites: { description: "Sites the user named for this question; empty when none.", items: { type: "string" }, type: "array" },
            source_classes: { items: sourceClass, type: "array" }
          },
          required: ["question", "sites", "source_classes"],
          type: "object"
        },
        type: "array"
      },
      skipped_source_classes: {
        description: "Source classes that do not apply to this goal, each with its reason; empty when all apply.",
        items: {
          additionalProperties: false,
          properties: { reason: { type: "string" }, source_class: sourceClass },
          required: ["source_class", "reason"],
          type: "object"
        },
        type: "array"
      }
    },
    required: ["goal", "questions", "skipped_source_classes"],
    type: "object"
  },
  name: START_RESEARCH_TOOL_NAME,
  strict: false
};

export const submitResearchDraftTool: RunTool = {
  capability: "session",
  description: "Hand in the research report once the researchers finished. Nothing you write while research runs reaches the user " +
    "except this report: the server checks it and either shows it to the user exactly as written, so do not write it again, or " +
    "tells you what to do before you submit again. Pass the whole report each time. Refused until start_research ran.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      findings: {
        description: "Every claim the report rests on.",
        items: {
          additionalProperties: false,
          properties: {
            claim: { type: "string" },
            quote: { description: "Copied verbatim from the page an agent opened; never paraphrased.", type: "string" },
            source_class: sourceClass,
            standing: { description: "confirmed: an independent source you opened says so. claimed: only a party with an interest says so. " +
              "not_verified: no opened source settles it.", enum: [...RESEARCH_STANDINGS], type: "string" },
            url: { type: "string" }
          },
          required: ["claim", "url", "quote", "source_class", "standing"],
          type: "object"
        },
        type: "array"
      },
      report: { description: "The report in Markdown, in the user's language, exactly as the user should read it: confirmed, claimed by a " +
        "party and not verified kept apart, sources linked, and what could not be reached said plainly.", type: "string" },
      unreachable: {
        description: "Sources that could not be reached; empty when none.",
        items: {
          additionalProperties: false,
          properties: {
            reason: { type: "string" },
            source_class: { anyOf: [sourceClass, { type: "null" }] },
            target: { description: "The site or source.", type: "string" }
          },
          required: ["target", "source_class", "reason"],
          type: "object"
        },
        type: "array"
      }
    },
    required: ["report", "findings", "unreachable"],
    type: "object"
  },
  name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME,
  strict: false
};

/** The ephemeral last provider message of a round that offers only the reserved draft. */
export function researchDraftReservedInstruction(): string {
  return `The time for research is up. Call ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME} now with the whole report from what you have, taking in ` +
    "anything the user just wrote and naming what could not be checked, and call no other tool.";
}
