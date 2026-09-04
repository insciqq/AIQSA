import { describe, expect, it } from "vitest";
import { createWorkspaceAvailabilityService } from "./availability";

describe("Workspace chat availability projection", () => {
  it("uses current policy before start and preserves the actual session network snapshot", async () => {
    const service = createWorkspaceAvailabilityService({
      health: {
        invalidate() {},
        async read() { return { state: "ready" }; }
      },
      policy: {
        async read() { return { enabled: true, internetEnabled: true, version: 2 }; },
        async update() { return { kind: "stale" }; }
      }
    });
    const snapshot = await service.snapshot();
    expect(service.project(snapshot, {
      enabled: true,
      modelSupportsTools: true,
      session: null
    })).toEqual({
      available: true,
      enabled: true,
      internetEnabled: true,
      sessionState: "not_started"
    });
    expect(service.project(snapshot, {
      enabled: true,
      modelSupportsTools: true,
      session: { internetEnabled: false, state: "STOPPED" }
    })).toMatchObject({ internetEnabled: false, sessionState: "stopped" });
  });

  it("uses stable unavailable-reason precedence", async () => {
    const service = createWorkspaceAvailabilityService({
      health: {
        invalidate() {},
        async read() { return { reasonCode: "hidden", state: "unavailable" }; }
      },
      policy: {
        async read() { return { enabled: true, internetEnabled: false, version: 1 }; },
        async update() { return { kind: "stale" }; }
      }
    });
    const snapshot = await service.snapshot();
    expect(service.project(snapshot, {
      enabled: false,
      modelSupportsTools: false,
      session: null
    })).toMatchObject({ available: false, unavailableReason: "runtime_unavailable" });
  });
});
