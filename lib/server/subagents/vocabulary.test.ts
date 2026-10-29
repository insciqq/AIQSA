// @vitest-environment node
import {
  MessageSystemTurnKind,
  RunFollowupOrigin,
  SubagentBindingSource,
  SubagentOutcome,
  SubagentTurnMode,
  SubagentTurnState,
  UsagePurpose
} from "@prisma/client";
import { describe, expect, it } from "vitest";
import { isMessageSystemTurnKind } from "../../contracts/mcpApprovals";
import {
  RUN_FOLLOWUP_ORIGINS,
  SUBAGENT_BINDING_SOURCES,
  SUBAGENT_CALLBACK_TURN_KIND,
  SUBAGENT_OUTCOMES,
  SUBAGENT_THREAD_STATES,
  SUBAGENT_TURN_MODES,
  SUBAGENT_USAGE_PURPOSE
} from "../../contracts/subagents";
import { isPersonalUsagePurpose, isRunUsageAttributionPurpose } from "../../domain/usagePurpose";

describe("sub-agent vocabulary", () => {
  it("stores exactly the values the wire contract names", () => {
    expect(Object.values(SubagentTurnState)).toEqual([...SUBAGENT_THREAD_STATES]);
    expect(Object.values(SubagentOutcome)).toEqual([...SUBAGENT_OUTCOMES]);
    expect(Object.values(SubagentTurnMode)).toEqual([...SUBAGENT_TURN_MODES]);
    expect(Object.values(SubagentBindingSource)).toEqual([...SUBAGENT_BINDING_SOURCES]);
    expect(Object.values(RunFollowupOrigin)).toEqual([...RUN_FOLLOWUP_ORIGINS]);
  });

  it("knows the wake-up turn and the sub-agent usage purpose", () => {
    expect(Object.values(MessageSystemTurnKind)).toContain(SUBAGENT_CALLBACK_TURN_KIND);
    // A reader sees the wake-up turn as server-written, never as the user's speech.
    expect(isMessageSystemTurnKind(SUBAGENT_CALLBACK_TURN_KIND)).toBe(true);
    expect(isMessageSystemTurnKind("answer_review_request")).toBe(false);
    expect(Object.values(UsagePurpose)).toContain(SUBAGENT_USAGE_PURPOSE);
    expect(isPersonalUsagePurpose(SUBAGENT_USAGE_PURPOSE)).toBe(true);
    expect(isRunUsageAttributionPurpose(SUBAGENT_USAGE_PURPOSE)).toBe(true);
  });
});
