import { PROPOSE_RESEARCH_PLAN_TOOL_NAME, RESEARCH_FRAME_LIMITS, RESEARCH_LIMITS, RESEARCH_PLAN_LIMITS, RESEARCH_SOURCE_CLASSES, RESEARCH_TIME_MS, START_RESEARCH_TOOL_NAME,
  SUBMIT_RESEARCH_DRAFT_TOOL_NAME } from "../../contracts/research";
import type { RunTool } from "./types";

/**
 * The research method's tools (operator decisions 2026-11-01): the model starts research when the user's goal is a thorough
 * result, proposes its plan after scoping, and hands in its report as a draft. All ride on every request of a run that offers
 * research, so the tool list stays the same across a chat's turns (provider prompt caches); the plan and the draft are refused
 * until research started. They are the main agent's only, added beside the sub-agent tools (`lib/server/engine/execution.ts`),
 * and a run reserves the draft call outside its budgets once the plan stands (`lib/server/tools/reservedToolCall.ts` is the
 * pattern; `lib/server/research/run.ts` the owner).
 */
export { PROPOSE_RESEARCH_PLAN_TOOL_NAME, START_RESEARCH_TOOL_NAME, SUBMIT_RESEARCH_DRAFT_TOOL_NAME };

const sourceClass = { description: "primary_official: the maker, the regulator, official documents. independent_tests: labs, independent " +
  "reviews and measurements. owner_reviews: what owners and users report, complaints included. action_channel: where the user will " +
  "buy or act, with its current prices, stock and terms.", enum: [...RESEARCH_SOURCE_CLASSES], type: "string" };

export const startResearchTool: RunTool = {
  capability: "session",
  description: "Call this first, before any search, when the user asks to research, analyze, compare for a decision or search carefully " +
    "(for example \"проанализируй\", \"глубокий анализ\", \"проведи исследование\", \"поищи хорошо\", \"investiga a fondo\", \"haz un análisis detallado\", \"investiga a fons\"). It starts the research method: it takes longer, costs more, runs parallel " +
    "researchers and the server checks the report before the user sees it. Give only the goal: the user sees at once that a plan is " +
    `being made, you find out how such a thing is chosen, and ${PROPOSE_RESEARCH_PLAN_TOOL_NAME} comes next. Result: how to scope. Not for simple questions or quick lookups.`,
  inputSchema: {
    additionalProperties: false,
    properties: {
      goal: { description: "What the user wants to decide or know, in one or two sentences.", type: "string" }
    },
    required: ["goal"],
    type: "object"
  },
  name: START_RESEARCH_TOOL_NAME,
  strict: false
};

const keyed = (properties: Readonly<Record<string, unknown>>) => ({
  additionalProperties: false,
  properties: { key: { description: "Stable for the whole research: lowercase letters, digits, - or _.", type: "string" }, ...properties },
  required: ["key", ...Object.keys(properties)],
  type: "object"
});

const label = { type: "string" };

export const proposeResearchPlanTool: RunTool = {
  capability: "session",
  description: "Show the user your plan after scoping, before any researcher starts. The user sees how you understood the task, your " +
    "assumptions and the steps, and may change them for a moment; with no action research starts by itself, so never wait for an " +
    "answer and never ask a question. The criteria come from what you read while scoping, in plain words, each with why it matters; a " +
    "knowledge question lists its outcomes or sub-questions there. What is unknown about the user and changes the result goes in branches. " +
    "This call returns when the plan stands, with the final plan and whether the user changed it. " +
    "Refused until start_research ran. When the result says the user changed the plan, call this once more with the user's words " +
    "and your questions rebuilt from them: no window opens then.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      assumptions: { description: "What you assume in place of asking the user, each named plainly; empty when nothing is assumed.", items: { type: "string" }, type: "array" },
      branches: {
        description: "What is unknown about the user and changes the result, each with the cases the report will split by, as in \"up to 70 kg, A; heavier, B\"; empty when none.",
        items: keyed({ cases: { items: keyed({ label }), type: "array" }, unknown: { description: "What is unknown about the user.", type: "string" } }),
        type: "array"
      },
      criteria: {
        description: "What the answer is judged by, at least one, found in the guides and standards you read while scoping and not from memory. For a knowledge question: its outcomes or sub-questions. " +
          "For a purchase, the current offer (where to buy, the seller, the price) and owners' reviews are criteria too, so every option found gets them as cells to fill.",
        items: keyed({ criterion: { description: "In plain words, in the user's language.", type: "string" },
          decisive: { description: "true for a key specification: a property of the option itself that the pick depends on and sellers may state differently, such as a mattress's " +
            `load per side, height and layers. Each option the report recommends gets it confirmed from two sites. At most ${RESEARCH_FRAME_LIMITS.decisiveCriteria}; false for the offer, ` +
            "the price, owners' reviews and a knowledge question's outcomes.", type: "boolean" },
          why: { description: "Why it matters to the user, in plain words.", type: "string" } }),
        type: "array"
      },
      questions: {
        description: "The questions that together answer the goal, each small enough for one researcher. Every source class goes to a question or into skipped_source_classes. " +
          "They run at once, so none may need another's answer: what needs the options found, such as their owners' reviews, current offers or key specifications, is no question but " +
          "a criterion, whose cells the next round fills once the rows exist.",
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
      rows: { description: "The options the user could choose known so far; empty when researchers will find them. A test, a source or a method is evidence, not a row. " +
        "Chosen by a rule you can state, not by what a search showed first: leave it empty if you have not applied it yet, and researchers add them.", items: keyed({ label }), type: "array" },
      skipped_source_classes: {
        description: "Source classes that do not apply to this goal, each with its reason; empty when all apply.",
        items: {
          additionalProperties: false,
          properties: { reason: { type: "string" }, source_class: sourceClass },
          required: ["source_class", "reason"],
          type: "object"
        },
        type: "array"
      },
      steps: { description: `The plan as the user reads it: ${RESEARCH_PLAN_LIMITS.stepsMin} to ${RESEARCH_PLAN_LIMITS.stepsMax} short steps, in the user's language.`, items: { type: "string" }, type: "array" },
      understood: { description: "How you understood the task, in the user's language.", type: "string" }
    },
    required: ["understood", "assumptions", "steps", "criteria", "rows", "branches", "questions", "skipped_source_classes"],
    type: "object"
  },
  name: PROPOSE_RESEARCH_PLAN_TOOL_NAME,
  strict: false
};

export const submitResearchDraftTool: RunTool = {
  capability: "session",
  description: "Hand in the research report once the researchers finished. Nothing you write while research runs reaches the user " +
    "except this report: the server checks it and either shows it to the user exactly as written, its summary above the report, so do not write it again, or " +
    "tells you what to do before you submit again. Pass the whole report with its summary, or after a send back pass edits against the latest draft the checks saw. " +
    "With edits, omit report and omit summary to keep it, or give its full replacement. Always give record_ids, pick_row_key, branch_picks, does_not_separate and unreachable " +
    "in full each time; they are never inherited. The report rests on records: you pass their ids, never " +
    "their text, and every check reads each claim from its record. Refused until the plan stands.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      branch_picks: {
        description: "The row picked for each case of each branch of the matrix, the same row where a case changes nothing; empty when the matrix has no branches or you pick nothing.",
        items: {
          additionalProperties: false,
          properties: { branch_key: { type: "string" }, case_key: { type: "string" }, row_key: { type: "string" } },
          required: ["branch_key", "case_key", "row_key"],
          type: "object"
        },
        type: "array"
      },
      does_not_separate: { anyOf: [{
        additionalProperties: false,
        description: "When the data does not tell rows apart. Say the same in the report, in the same words.",
        properties: {
          row_keys: { description: "The rows it does not tell apart, at least two.", items: { type: "string" }, type: "array" },
          statement: { description: "What the data does not tell apart, in the user's language.", type: "string" },
          would_decide: { description: "What would decide between them, such as trying them, in the user's language.", type: "string" }
        },
        required: ["row_keys", "statement", "would_decide"],
        type: "object"
      }, { type: "null" }] },
      edits: {
        description: `Instead of report after a send back: at most ${RESEARCH_LIMITS.draftEdits} exact old/new pairs, at most ${RESEARCH_LIMITS.draftEditCharacters} characters per text and ` +
          `${RESEARCH_LIMITS.draftEditsCharacters} characters total. Each old must occur exactly once in the previous report, edits cannot overlap, and all apply or none do. ` +
          `The resulting report stays within ${RESEARCH_LIMITS.reportCharacters} characters. [] keeps the report while replacing references or summary.`,
        items: {
          additionalProperties: false,
          properties: {
            new: { description: "Exact replacement text; empty deletes the old text.", maxLength: RESEARCH_LIMITS.draftEditCharacters, type: "string" },
            old: { description: "Exact text in the previous report, including whitespace; never text from the summary or from another edit's replacement.",
              maxLength: RESEARCH_LIMITS.draftEditCharacters, minLength: 1, type: "string" }
          },
          required: ["old", "new"],
          type: "object"
        },
        maxItems: RESEARCH_LIMITS.draftEdits,
        type: "array"
      },
      pick_row_key: { anyOf: [{ description: "The row of the matrix the report picks, for every user alike.", type: "string" }, { type: "null" }] },
      record_ids: {
        description: "The ids of the records the report rests on, as listed after each researcher's report and returned by record_evidence: every record behind a figure, a price, " +
          "a seller, a review or a link you state, those of your pick above all. Empty only for advice that states no fact.",
        items: { type: "string" },
        type: "array"
      },
      report: { description: "The report in Markdown, in the user's language, exactly as the user should read it below the summary, which it does not repeat: the comparison table on the matrix's criteria first, " +
        "why each criterion matters, any criterion added during research with its reason, for a purchase each recommended option's current offers and the options kept in reserve with one reason each, " +
        "confirmed, claimed by a party and not verified kept apart compactly, each figure and named claim linked to its page where it is stated, and what could not be reached said plainly.", type: "string" },
      summary: {
        additionalProperties: false,
        description: "What the user reads first: the server puts it above the report, and most readers stop there.",
        properties: {
          row_keys: { description: "The rows of the matrix the summary recommends, in its order: the pick first, then the alternatives. Empty only when it recommends no row, as for a knowledge question.",
            items: { type: "string" }, type: "array" },
          text: { description: `Two to four short paragraphs in the user's language, at most ${RESEARCH_LIMITS.summaryCharacters} characters, no heading and no table: the option to take for the user's ` +
            "criteria, then the alternatives for their other likely priorities, such as cheaper or a different feel, each named as the matrix names it and, for a purchase, with its price and where to buy it.", type: "string" }
        },
        required: ["row_keys", "text"],
        type: "object"
      },
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
    // The non-strict tool keeps both forms optional here; the decoder enforces report or edits and the report check requires the summary.
    required: ["record_ids", "pick_row_key", "branch_picks", "does_not_separate", "unreachable"],
    type: "object"
  },
  name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME,
  strict: false
};

/** The ephemeral last provider message of a round that offers only the reserved draft. */
export function researchDraftReservedInstruction(): string {
  return `The time for research is up. Call ${SUBMIT_RESEARCH_DRAFT_TOOL_NAME} now with the summary and the whole report from what you have, taking in ` +
    "anything the user just wrote and naming what could not be checked, and call no other tool.";
}

const SCOPING_MINUTES = RESEARCH_TIME_MS.scoping / 60_000;

/** What `start_research` returns: how the model gets to its plan. The user sees that a plan is being made while this runs. */
export function researchScopingInstructions(): string {
  return [
    `Research started with scoping: you have up to ${SCOPING_MINUTES} minutes before the plan. Read a few guides or standards on how such a thing ` +
      "is chosen and find the criteria yourself: the user may not know what matters, and criteria from memory float between runs.",
    "Write each criterion in plain words with why it matters. A knowledge question gets its outcomes or sub-questions in the same place, each with why it matters.",
    `For a choice between options, mark as decisive the few key specifications a pick depends on, at most ${RESEARCH_FRAME_LIMITS.decisiveCriteria}: the recommended options get them confirmed from two sites.`,
    `Then call ${PROPOSE_RESEARCH_PLAN_TOOL_NAME}. Do not wait until the time is up, and do not start researchers: they start after the plan.`,
    "Ask the user nothing, here or in the plan: what you lack becomes a named assumption. What is unknown about the user and changes the result " +
      "becomes a branch with its cases, so the report can say \"up to 70 kg, A; heavier, B\".",
    "Nothing you write now reaches the user."
  ].join("\n");
}

/** What a tool past scoping's limit returns instead of running. */
export function researchScopingOverMessage(): string {
  return `Nothing was run: the time for scoping is up. Call ${PROPOSE_RESEARCH_PLAN_TOOL_NAME} now with what you have, naming what you could not find out as assumptions.`;
}
