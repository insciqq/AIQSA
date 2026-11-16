import { describe, expect, it } from "vitest";
import { DISCORD_COPY, DISCORD_WORKSPACE_COPY } from "../copy";
import { discordRunFailure, discordSendRefusalFailure } from "./refusals";

describe("a Discord answer the Workspace could not give", () => {
  it("says the thread's Workspace is busy, whether admission refused it or the turn waited too long for it", () => {
    expect(discordSendRefusalFailure({ code: "workspace_busy" })).toEqual({
      code: "workspace_busy", failureKind: "busy", text: DISCORD_WORKSPACE_COPY.busy
    });
    expect(discordRunFailure("workspace_followup_expired")).toEqual({
      code: "workspace_followup_expired", failureKind: "busy", text: DISCORD_WORKSPACE_COPY.busy
    });
  });

  it("says a full Workspace has no room for the turn's files", () => {
    expect(discordRunFailure("workspace_storage_full")).toEqual({
      code: "workspace_storage_full", failureKind: "run", text: DISCORD_WORKSPACE_COPY.full
    });
  });

  it("says the Workspace is unavailable when the runner is off, unreachable or could not start the thread's VM", () => {
    for (const code of ["workspace_disabled", "workspace_runtime_unavailable", "workspace_runtime_incompatible"]) {
      expect(discordSendRefusalFailure({ code })).toEqual({ code, failureKind: "admission", text: DISCORD_WORKSPACE_COPY.unavailable });
    }
    for (const code of ["workspace_runtime_unavailable", "workspace_session_create_failed", "workspace_session_lost"]) {
      expect(discordRunFailure(code)).toEqual({ code, failureKind: "run", text: DISCORD_WORKSPACE_COPY.unavailable });
    }
  });

  it("names the Workspace for any other of its failures, and never says only that something went wrong", () => {
    for (const code of ["workspace_output_limit_exceeded", "workspace_followup_predecessor_failed", "workspace_something_new"]) {
      const failed = discordRunFailure(code);
      expect(failed).toEqual({ code, failureKind: "run", text: DISCORD_WORKSPACE_COPY.failed });
      expect(failed.text).not.toBe(DISCORD_COPY.somethingWrong);
    }
    // Other unknown codes keep the generic text.
    expect(discordRunFailure("run_execution_failed").text).toBe(DISCORD_COPY.somethingWrong);
  });
});
