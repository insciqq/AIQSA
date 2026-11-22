import { describe, expect, it } from "vitest";
import { UNAVAILABLE_CHAT_WORKSPACE_STATE, type ChatWorkspaceState } from "@/lib/contracts/workspace";
import { workspaceAvailabilityV2, workspaceNotRequestedReasonV2, workspaceUnusableMessageV2, type WorkspaceAvailabilityV2 } from "./workspaceAvailability";

const offered: ChatWorkspaceState = { available: true, enabled: true, internetEnabled: true, sessionState: null };
const runtimeDown: ChatWorkspaceState = { ...UNAVAILABLE_CHAT_WORKSPACE_STATE, unavailableReason: "runtime_unavailable" };

describe("Workspace availability", () => {
  it.each([
    // A read that has not succeeded is unknown, whether the shell's state or the dispatch summary says so (67286bdf4).
    ["no read yet, model with tools", null, true, { state: "unknown" }, null],
    ["unknown at dispatch, model with tools", "unknown", true, { state: "unknown" }, null],
    ["no reader at dispatch", undefined, true, { state: "unknown" }, null],
    ["offered, model with tools", offered, true, { state: "usable" }, null],
    ["available at dispatch, model with tools", "available", true, { state: "usable" }, null],
    // Only a successful read says off, with the installation's own reason.
    ["disabled by the administrator", UNAVAILABLE_CHAT_WORKSPACE_STATE, true,
      { cause: "installation", reason: "installation_disabled", state: "unusable" }, "installation_disabled"],
    ["runtime down", runtimeDown, true, { cause: "installation", reason: "runtime_unavailable", state: "unusable" }, "installation_disabled"],
    ["off at dispatch", "off", true, { cause: "installation", state: "unusable" }, "installation_disabled"],
    ["off, model without tools", "off", false, { cause: "installation", state: "unusable" }, "installation_disabled"],
    // A model without tools rules Workspace out whatever the installation, also before any read succeeded.
    ["offered, model without tools", offered, false, { cause: "model", reason: "model_tools_required", state: "unusable" }, "model_no_tools"],
    ["no read yet, model without tools", null, false, { cause: "model", reason: "model_tools_required", state: "unusable" }, "model_no_tools"]
  ] as const)("%s", (_name, installation, modelCallsTools, expected, notRequested) => {
    const availability = workspaceAvailabilityV2(installation, modelCallsTools);
    expect(availability).toEqual(expected);
    expect(workspaceNotRequestedReasonV2(availability)).toBe(notRequested);
  });

  it("tells the user why a file that needs Workspace cannot attach", () => {
    const unusable = (availability: WorkspaceAvailabilityV2) => {
      if (availability.state !== "unusable") throw new Error("expected unusable");
      return workspaceUnusableMessageV2(availability);
    };
    expect(unusable(workspaceAvailabilityV2(null, false))).toBe("Workspace requires a model with tool support.");
    expect(unusable(workspaceAvailabilityV2(UNAVAILABLE_CHAT_WORKSPACE_STATE, true))).toBe("Workspace is disabled by the administrator.");
    expect(unusable(workspaceAvailabilityV2(runtimeDown, true))).toBe("Workspace runtime is unavailable.");
    expect(unusable(workspaceAvailabilityV2("off", true))).toBe("Workspace runtime is unavailable.");
  });
});
