import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AdminProviderCheckRun } from "@/lib/contracts/adminProviders";
import { fixtureCheckRun } from "../providerFixtures";
import { AdminProviderSetupResults, capabilityAttemptDescription, providerSetupNeedsRecovery } from "./AdminProviderSetupResults";

function completed(overrides: Partial<AdminProviderCheckRun> = {}) {
  return fixtureCheckRun({ id: "run", credentialId: "key", done: 1, total: 1, state: "completed", ...overrides });
}

describe("compact setup results", () => {
  it("keeps an eleven-model optional capability report to one summary", () => {
    const models = Array.from({ length: 11 }, (_, index) => ({ id: `model-${index}`, displayName: `Model ${index}` }));
    const run = completed({ total: 11, done: 11, failed: ["model-9", "model-10"], results: models.map((model, index) => ({
      providerModelId: model.id, state: index < 9 ? "saved" : "partial", checks: {
        modelAccess: "verified", toolCalling: "verified", structuredOutput: "verified", vision: "unsupported", forcedToolCall: "incomplete"
      }
    })) });
    render(<AdminProviderSetupResults models={models} run={run} />);
    const summary = screen.getByRole("group", { name: "Model setup summary" });
    expect(summary).toHaveTextContent("11 of 11 model results saved.");
    expect(summary.querySelectorAll("p")).toHaveLength(1);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(summary).not.toHaveTextContent(/Model 0|Forced tool calls|attention/);
    expect(summary.querySelector(".text-critical")).toBeNull();
    expect(providerSetupNeedsRecovery(run)).toBe(false);
  });

  it.each(["save_failed", "check_failed", "cancelled", "stale"] as const)("keeps %s recovery reachable despite verified checks", (state) => {
    expect(providerSetupNeedsRecovery(completed({ results: [{ providerModelId: "m", state, checks: { modelAccess: "verified" } }] }))).toBe(true);
  });

  it.each([
    { state: "cancelled" as const }, { state: "interrupted" as const }, { done: 0 }, { total: 0 },
    { failed: ["unknown"] }, { skipped: ["changed"] }, { setup: { state: "running" as const } },
    { setup: { state: "partial" as const, search: "failed" as const, defaults: [] } },
    { setup: { state: "partial" as const, search: "ready" as const, defaults: [] } }
  ])("keeps incomplete model or automatic setup recoverable: %j", (overrides) => {
    expect(providerSetupNeedsRecovery(completed(overrides))).toBe(true);
  });

  it("does not ask to retry settled unsupported access but preserves unknown access failures", () => {
    const run = completed({ failed: ["m"], results: [{ providerModelId: "m", state: "unavailable", checks: { modelAccess: "unsupported" } }] });
    expect(providerSetupNeedsRecovery(run)).toBe(false);
    expect(providerSetupNeedsRecovery({ ...run, results: [{ providerModelId: "m", state: "unavailable" }] })).toBe(true);
    expect(providerSetupNeedsRecovery(null)).toBe(true);
  });

  it("projects only allowlisted reason and bounded status/attempt metadata", () => {
    expect(capabilityAttemptDescription({ attempts: 3, status: "incomplete", reason: "malformed_tool_output" }))
      .toBe("the model returned an invalid tool call · 3 attempts");
    expect(capabilityAttemptDescription({ attempts: 0, status: "incomplete", reason: "timeout", httpStatus: 200 }))
      .toBe("check timed out");
  });
});
