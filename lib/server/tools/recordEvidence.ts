import {
  decodeResearchRecord,
  RECORD_EVIDENCE_TOOL_NAME,
  RESEARCH_RECORD_KINDS,
  RESEARCH_SOURCE_CLASSES,
  RESEARCH_STANDINGS,
  START_RESEARCH_TOOL_NAME,
  type ResearchAgentRef,
  type ResearchEvidenceRecord
} from "../../contracts/research";
import type { EngineTool } from "../engine/toolRegistry";
import { RESEARCH_CHECK_REASONS } from "../research/evidenceStore";
import type { ResearchEvidencePort } from "../research/ports";
import type { WorkspaceAgent } from "../subagents/guestProtocol";
import { harnessToolError } from "./harnessTool";
import type { RunTool, ToolExecutionResult } from "./types";

/**
 * `record_evidence`: a finding becomes a durable record the moment an agent makes it (`lib/server/research/evidenceStore.ts`), for the main
 * agent and every researcher of a run that offers research. Who wrote it comes from the registry that built the tool, never from the model.
 * `strict: false` like the other research tools, though every field is required: `decodeResearchRecord` wants null where a kind has no use for
 * a field, and names the one to correct. A tool of the `session` capability, so a turn whose tool groups narrow its tools, such as a gate's,
 * is never offered it (`lib/server/engine/subagents/registry.ts`). The result stays short: the id, the quote check's word and what to do.
 */
export { RECORD_EVIDENCE_TOOL_NAME };

const text = (description: string) => ({ description, type: "string" });
const nullableText = (description: string) => ({ description, type: ["string", "null"] });

const sourceClass = { description: "primary_official: the maker, the regulator, official documents. independent_tests: labs, independent reviews and " +
  "measurements. owner_reviews: what owners and users report. action_channel: where the user will buy or act.", enum: [...RESEARCH_SOURCE_CLASSES], type: "string" };

export const recordEvidenceTool: RunTool = {
  capability: "session",
  description: "Keep one piece of evidence as soon as you have it, while you still have the page: it lasts whatever happens to the report. kind finding: a claim " +
    "with its link and a quote copied word for word from the page you opened. The server checks the quote on the spot against what you read and keeps that page's text " +
    "with the record, so do not repeat it here. not_found: nothing was found for a matrix cell (row_key and criterion_key), which counts as filled. dataset: what a " +
    "script collected, with its method, sample and verbatim examples. unreachable: a site you could not reach, and why. Every field is required: pass null where a " +
    "kind has no use for it. Nothing is ever changed or deleted: to correct a record, write a new one with supersedes set to its id. Result: the record's id, what the " +
    `quote check found and what to do next. Refused until ${START_RESEARCH_TOOL_NAME} ran, once the research holds as many records as it may, and for a supersedes that names ` +
    "no record of this research or one already corrected.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      claim: nullableText("finding, dataset: what the source says, in one sentence."),
      criterion_key: nullableText("The matrix criterion this is about; required for not_found, otherwise null when none."),
      dataset: { anyOf: [{
        additionalProperties: false,
        description: "dataset only: how it was made, so a verifier can check it and a small sample is never read as a rate.",
        properties: {
          counts: { description: "What was counted; empty when nothing was.", items: { additionalProperties: false,
            properties: { count: { type: "integer" }, label: { type: "string" } }, required: ["label", "count"], type: "object" }, type: "array" },
          examples: { description: "A few verbatim examples, each with its link.", items: { additionalProperties: false,
            properties: { quote: { type: "string" }, url: { type: "string" } }, required: ["quote", "url"], type: "object" }, type: "array" },
          left_out: text("What was left out of the sample."),
          method: text("How it was collected."),
          sample_size: { description: "The number of items read.", type: "integer" }
        },
        required: ["method", "sample_size", "left_out", "counts", "examples"],
        type: "object"
      }, { type: "null" }] },
      kind: { enum: [...RESEARCH_RECORD_KINDS], type: "string" },
      quote: nullableText("finding only: copied word for word from the page you opened, never paraphrased."),
      reason: nullableText("not_found: where you looked. unreachable: why it could not be reached."),
      row_key: nullableText("The matrix row this is about; required for not_found and dataset, otherwise null when none."),
      source_class: { anyOf: [sourceClass, { type: "null" }] },
      standing: { anyOf: [{ description: "finding, dataset. confirmed: an independent source you opened says so. claimed: only a party with an interest says so. " +
        "not_verified: no opened source settles it.", enum: [...RESEARCH_STANDINGS], type: "string" }, { type: "null" }] },
      supersedes: nullableText("The id of the record this one corrects; null for a new one."),
      target: nullableText("unreachable only: the site."),
      url: nullableText("finding, dataset: the source's http or https link.")
    },
    required: ["kind", "claim", "url", "quote", "source_class", "standing", "row_key", "criterion_key", "reason", "target", "dataset", "supersedes"],
    type: "object"
  },
  name: RECORD_EVIDENCE_TOOL_NAME,
  strict: false
};

/** What a run's `record_evidence` reaches: the one port of its research, and whether a plan stands (`RunResearch.holding`). */
export type RecordEvidenceTarget = Readonly<{ evidence: Pick<ResearchEvidencePort, "record">; planStands(): boolean }>;

const CORRECT = `call ${RECORD_EVIDENCE_TOOL_NAME} again with supersedes set to this record's id`;

const NOT_CHECKED: Readonly<Record<string, string>> = {
  browser_page: `the quote is not in what the browser printed. If it is on the page, print the text that holds it, then ${CORRECT}.`,
  other_tool_output: `the quote is only in another tool's output, which is no page. If it comes from a page, open that page, then ${CORRECT}.`,
  [RESEARCH_CHECK_REASONS.pageNotStored]: "this research keeps no more page text, so nothing later can read this page. The record stands.",
  [RESEARCH_CHECK_REASONS.pageTruncated]: "the page is longer than what is kept and the quote is past that point. The record stands.",
  partial_source: "only part of this page could be read, and the quote is not in that part. The record stands.",
  sources_over_limit: "the quote is not in your latest results, and your older ones are not read here. The record stands.",
  sources_unreadable: "your results could not be read just now. The record stands."
};

/** What the agent reads of the check: the word, and at once what to do while it still has the page. */
function checkMessage(check: NonNullable<ResearchEvidenceRecord["quoteCheck"]>): string {
  switch (check.status) {
    case "found":
      return check.reason === RESEARCH_CHECK_REASONS.otherPage ? `Recorded. The quote is on another page you opened, not the link you gave: ${CORRECT} and that page's link.`
        : "Recorded. The quote is on the page.";
    case "not_verbatim":
      return `Recorded, but this quote is not on the page. Copy it word for word from the page, then ${CORRECT}, while you still have the page.`;
    case "not_checked":
      return `Recorded, not checked: ${NOT_CHECKED[check.reason ?? ""] ?? "the record stands."}`;
    case "unsupported":
      return check.reason === "search_snippet_only" ? `Recorded, but the quote is only in search results, and a snippet is no evidence. Open the page, then ${CORRECT}.`
        : `Recorded, but you have not read this quote on any page. Open the page with fetch_url or the browser, then ${CORRECT}.`;
  }
}

const NOT_STARTED = `Nothing was recorded: research has not started. Call ${START_RESEARCH_TOOL_NAME} first, or answer the user directly if this needs no research.`;

function recordedResult(call: Readonly<{ id: string; name: string }>, record: ResearchEvidenceRecord): ToolExecutionResult {
  const check = record.quoteCheck;
  return { callId: call.id, content: [{ type: "json", value: { message: check ? checkMessage(check) : "Recorded.", ...check ? { quote_check: check.status } : {}, record_id: record.id } }],
    name: call.name, status: "complete" };
}

/** The tool of one agent, whose author is that agent's: the main agent's, or a sub-agent's by its thread. */
export function recordEvidenceEngineTool(target: RecordEvidenceTarget, agent: WorkspaceAgent | undefined): EngineTool {
  const author: ResearchAgentRef = agent?.kind === "subagent" ? { name: agent.name, threadId: agent.threadId } : { name: null, threadId: null };
  return {
    activity: () => ({ origin: "tool", serverName: "Research", toolName: "Recording evidence" }),
    definition: recordEvidenceTool,
    effects: "local",
    observationSource: "workspace",
    execute: async ({ call, signal }) => {
      if (!target.planStands()) return harnessToolError(call, "research_not_started", NOT_STARTED);
      const decoded = decodeResearchRecord(call.arguments);
      if (!decoded.ok) return harnessToolError(call, "research_record_invalid", decoded.message);
      const written = await target.evidence.record({ author, record: decoded.value }, signal);
      return written.kind === "recorded" ? recordedResult(call, written.record) : harnessToolError(call, written.code, written.message);
    }
  };
}
