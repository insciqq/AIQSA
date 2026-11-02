import {
  CHANGE_RESEARCH_FRAME_TOOL_NAME,
  decodeResearchFrameChange,
  PROPOSE_RESEARCH_PLAN_TOOL_NAME,
  RESEARCH_FRAME_CHANGES,
  type ResearchAgentRef,
  type ResearchFrame,
  type ResearchFrameChangeRequest
} from "../../contracts/research";
import type { EngineTool } from "../engine/toolRegistry";
import { researchNotedCandidate } from "../research/candidates";
import type { ResearchCoveragePort } from "../research/ports";
import type { WorkspaceAgent } from "../subagents/guestProtocol";
import { harnessToolError } from "./harnessTool";
import type { RunTool } from "./types";

/**
 * `change_research_frame`: the one way the matrix grows once the plan stands (`lib/server/research/matrix.ts`), and the candidates beside it are
 * noted and set aside (`lib/server/research/candidates.ts`), for the main agent and every researcher of a run that offers research, offered as
 * `record_evidence` is, so whatever a researcher's tool groups and never to a gate's turn.
 * Who changed it comes from the registry that built the tool. `strict: false` like the other research tools, though every field is required:
 * `decodeResearchFrameChange` wants null where a change has no use for a field.
 */
export { CHANGE_RESEARCH_FRAME_TOOL_NAME };

const nullableText = (description: string) => ({ description, type: ["string", "null"] });

export const changeResearchFrameTool: RunTool = {
  capability: "session",
  description: "Add to the research matrix while research runs. add_row: an option the user could choose, by the rule the research states, never by what a search showed first, so its cells " +
    "can be filled; a test, a source or a method is evidence, recorded under the row it is about. add_criterion: something " +
    "that turned out to matter, which is a rarer thing: the report names every added criterion with your reason. add_branch: something unknown about the user that changes " +
    "the result, with its cases. note_candidate: an option you saw that the matrix lacks and you do not add as a row, such as a model a shop's listing or a ranking names, " +
    "under label its exact name as the page writes it, the model and not only its brand or line, with reason saying where you saw it and why it may be an option; key is null, " +
    "since the server makes it. The main agent then makes it a row or sets it aside. set_aside: the main agent only, for a noted candidate that is no option: key is the " +
    "candidate's key as the server listed it, with your reason; the report keeps it among the options it does not recommend. Nothing in the matrix is ever changed or removed, " +
    "and a record already written under a new key counts as soon as the key is added. Every field is required: pass null where a change has no use for it. Refused until the " +
    "plan stands, for a key the matrix already has, and once it holds as much as it may.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      cases: { anyOf: [{
        description: "add_branch only: the cases the report will split by, at least two.",
        items: { additionalProperties: false, properties: { key: { type: "string" }, label: { type: "string" } }, required: ["key", "label"], type: "object" },
        type: "array"
      }, { type: "null" }] },
      change: { enum: [...RESEARCH_FRAME_CHANGES], type: "string" },
      key: nullableText("Stable for the whole research: lowercase letters, digits, - or _. It is what records use as row_key or criterion_key. For set_aside, the candidate's " +
        "key as the server listed it; null for note_candidate."),
      label: nullableText("The row's name, the criterion in plain words, or what is unknown about the user, in the language of the research goal. For note_candidate, the " +
        "option's exact name as the page writes it; null for set_aside."),
      reason: { description: "Why the matrix changes; for note_candidate where you saw the option and why it may be one, and for set_aside why it is no option. In plain words, " +
        "in the language of the research goal; name no tool, since the report may carry it as written.", type: "string" },
      why: nullableText("add_criterion only: why this criterion matters to the user, in plain words, in the language of the research goal.")
    },
    required: ["change", "key", "label", "reason", "why", "cases"],
    type: "object"
  },
  name: CHANGE_RESEARCH_FRAME_TOOL_NAME,
  strict: false
};

/**
 * What a run's `change_research_frame` reaches: the one port of its research, and whether the matrix is open to change (`RunResearch.frameOpen`).
 * A plan that may still be rebuilt replaces the frame only while nobody has changed it, so a change then would cost the rebuilt criteria.
 */
export type ChangeResearchFrameTarget = Readonly<{ coverage: Pick<ResearchCoveragePort, "change">; open(): boolean }>;

const NOT_OPEN = `Nothing was changed: the matrix opens once the plan stands for good. Until then put this in ${PROPOSE_RESEARCH_PLAN_TOOL_NAME}.`;

/** What the agent reads of its change, from the frame it made: a candidate's key is the server's, and a second agent's note joins the first's. */
function changedMessage(request: ResearchFrameChangeRequest, frame: ResearchFrame, by: ResearchAgentRef): string {
  switch (request.change) {
    case "add_row": return `Row added: use row_key ${request.row.key}.`;
    case "add_criterion": return `Criterion added: use criterion_key ${request.criterion.key}. The report will name it with your reason.`;
    case "add_branch": return "Branch added: the report will split by its cases.";
    case "note_candidate": {
      const candidate = researchNotedCandidate(frame, request.label);
      const agents = candidate?.notes.length ?? 1;
      const noted = `Candidate noted under key ${candidate?.key ?? request.label}${agents > 1 ? `, by ${agents} agents now` : ""}`;
      return by.threadId === null ? `${noted}. Make it a row with add_row, or set it aside with set_aside and your reason.`
        : `${noted}. The main agent decides whether it becomes a row; go on with your question.`;
    }
    case "set_aside": return `Set aside: ${frame.setAside?.at(-1)?.key ?? request.key}. The report keeps it among the options it does not recommend, with your reason.`;
  }
}

/** The tool of one agent: the main agent's, or a sub-agent's by its thread. */
export function changeResearchFrameEngineTool(target: ChangeResearchFrameTarget, agent: WorkspaceAgent | undefined): EngineTool {
  const by: ResearchAgentRef = agent?.kind === "subagent" ? { name: agent.name, threadId: agent.threadId } : { name: null, threadId: null };
  return {
    activity: () => ({ origin: "tool", serverName: "Research", toolName: "Extending the matrix" }),
    definition: changeResearchFrameTool,
    effects: "local",
    observationSource: "workspace",
    execute: async ({ call, signal }) => {
      if (!target.open()) return harnessToolError(call, "research_frame_closed", NOT_OPEN);
      const decoded = decodeResearchFrameChange(call.arguments);
      if (!decoded.ok) return harnessToolError(call, "research_frame_change_invalid", decoded.message);
      const changed = await target.coverage.change(decoded.value, by, signal);
      if (!changed.ok) return harnessToolError(call, "research_frame_change_refused", changed.message);
      return { callId: call.id, content: [{ type: "json", value: { message: changedMessage(decoded.value, changed.value, by), status: "changed" } }], name: call.name, status: "complete" };
    }
  };
}
