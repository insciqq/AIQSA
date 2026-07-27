// @vitest-environment node

import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { describe, expect, it, vi } from "vitest";
import {
  McpActivationCoordinator,
  type McpActivationClaim,
  type McpActivationCoordinatorRepository
} from "./activationCoordinator";
import type { McpDraftValidator } from "./draftValidator";

const draft: McpDraftConfiguration = {
  auth: { mode: "none" },
  runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 45_000 },
  slots: [],
  source: { kind: "remote", url: "https://mcp.example.test/mcp" },
  transport: "streamable_http"
};

function claim(id = "activation-1"): McpActivationClaim {
  return {
    draft,
    id,
    leaseId: `lease-${id}`,
    serverId: `server-${id}`,
    validationUserId: "admin-1",
    values: {},
    workloadToken: `workload-${id}`
  };
}

function repository(
  claims: McpActivationClaim[],
  overrides: Partial<McpActivationCoordinatorRepository> = {}
): McpActivationCoordinatorRepository {
  return {
    advanceActivation: vi.fn(async () => true),
    claimActivation: vi.fn(async () => claims.shift() ?? null),
    failActivation: vi.fn(async () => true),
    heartbeatActivation: vi.fn(async () => true),
    publishActivation: vi.fn(async () => ({ kind: "published" as const })),
    ...overrides
  };
}

describe("MCP activation coordinator", () => {
  it("publishes only after reporting observable validator boundaries", async () => {
    const storage = repository([claim()]);
    const validator: McpDraftValidator = {
      async validate(input) {
        expect(input.workloadToken).toBe("workload-activation-1");
        await input.onProgress?.("connecting");
        await input.onProgress?.("discovering_tools");
        return {
          evidence: { toolCount: 1 },
          kind: "ok",
          resolvedArtifact: null,
          toolInventory: [{ description: "Search", name: "search" }]
        };
      }
    };
    const onPublished = vi.fn();
    const coordinator = new McpActivationCoordinator({
      draftValidator: validator,
      onPublished,
      repository: storage
    });

    await coordinator.reconcileNow();

    expect(storage.advanceActivation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: "activation-1",
      leaseId: "lease-activation-1",
      stage: "connecting"
    }));
    expect(storage.advanceActivation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      stage: "discovering_tools"
    }));
    expect(storage.advanceActivation).toHaveBeenNthCalledWith(3, expect.objectContaining({
      stage: "publishing"
    }));
    expect(storage.publishActivation).toHaveBeenCalledOnce();
    expect(storage.failActivation).not.toHaveBeenCalled();
    expect(onPublished).toHaveBeenCalledOnce();
  });

  it("stores a bounded stable failure instead of publishing invalid evidence", async () => {
    const storage = repository([claim()]);
    const validator: McpDraftValidator = {
      async validate() {
        return {
          issues: Array.from({ length: 25 }, (_, index) => ({
            code: index === 0 ? "unsafe code" : "connection_failed",
            path: index === 0 ? "unsafe path" : `source.${index}`
          })),
          kind: "invalid"
        };
      }
    };
    const coordinator = new McpActivationCoordinator({
      draftValidator: validator,
      repository: storage
    });

    await coordinator.reconcileNow();

    expect(storage.publishActivation).not.toHaveBeenCalled();
    expect(storage.failActivation).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "mcp_draft_test_failed",
      issues: expect.arrayContaining([{
        code: "mcp_activation_validation_failed",
        path: "validator"
      }])
    }));
    const failure = vi.mocked(storage.failActivation).mock.calls[0]?.[0];
    expect(failure?.issues).toHaveLength(20);
  });

  it("stops obsolete work when a compare-and-set progress write loses its lease", async () => {
    const storage = repository([claim()], {
      advanceActivation: vi.fn(async () => false)
    });
    const validator: McpDraftValidator = {
      async validate(input) {
        await input.onProgress?.("connecting");
        throw new Error("unreachable");
      }
    };
    const coordinator = new McpActivationCoordinator({
      draftValidator: validator,
      repository: storage
    });

    await coordinator.reconcileNow();

    expect(storage.failActivation).not.toHaveBeenCalled();
    expect(storage.publishActivation).not.toHaveBeenCalled();
  });

  it("heartbeats a long validation claim until it reaches publication", async () => {
    const storage = repository([claim()]);
    let release!: () => void;
    const validator: McpDraftValidator = {
      async validate() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { evidence: {}, kind: "ok", resolvedArtifact: null, toolInventory: [] };
      }
    };
    const coordinator = new McpActivationCoordinator({
      draftValidator: validator,
      heartbeatMs: 5,
      repository: storage
    });

    const running = coordinator.reconcileNow();
    await vi.waitFor(() => expect(storage.heartbeatActivation).toHaveBeenCalled());
    release();
    await running;

    expect(storage.heartbeatActivation).toHaveBeenCalledWith(expect.objectContaining({
      id: "activation-1",
      leaseId: "lease-activation-1"
    }));
    expect(storage.publishActivation).toHaveBeenCalledOnce();
  });

  it("never validates more than two installations concurrently", async () => {
    const claims = [claim("1"), claim("2"), claim("3")];
    const storage = repository(claims);
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const validator: McpDraftValidator = {
      async validate() {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return { evidence: {}, kind: "ok", resolvedArtifact: null, toolInventory: [] };
      }
    };
    const coordinator = new McpActivationCoordinator({
      draftValidator: validator,
      maxParallel: 2,
      repository: storage
    });

    const running = coordinator.reconcileNow();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(maximum).toBe(2);
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.splice(0).forEach((release) => release());
    await running;

    expect(maximum).toBe(2);
    expect(storage.publishActivation).toHaveBeenCalledTimes(3);
  });
});
