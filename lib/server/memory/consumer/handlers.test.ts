import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logEvent } from "../../observability";
import { rememberDatabaseFailure } from "../../observability/databaseFailure";
import { MEMORY_UTILITY_EGRESS_POLICY_VERSION } from "../execution/policy";
import type { MemorySettingsPersistenceSnapshot } from "../persistence/settings";
import { createMemorySettingsService } from "../settings/service";
import {
  createForgetMemoryConsumerItemHandler,
  createGetMemoryConsumerSettingsHandler,
  createListMemoryConsumerItemsHandler,
  createPatchMemoryConsumerSettingsHandler
} from "./handlers";
import { createMemoryConsumerService, MemoryConsumerServiceError } from "./service";

vi.mock("../../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../observability")>(),
  logEvent: vi.fn()
}));

function dependencies() {
  const list = vi.fn(async () => ({ items: [], nextCursor: null }));
  return {
    deps: {
      resolveAuth: vi.fn(async () => ({ userId: "user-1" })),
      service: { list }
    } as never,
    list
  };
}

describe("Memory consumer handlers", () => {
  it("passes bounded category and provenance filters to the service", async () => {
    const fixture = dependencies();
    const response = await createListMemoryConsumerItemsHandler(fixture.deps)(
      new Request(
        "http://test/api/me/memories?category=WORK&pageSize=7&provenance=LEARNED"
      )
    );

    expect(response.status).toBe(200);
    expect(fixture.list).toHaveBeenCalledWith("user-1", {
      category: "WORK",
      pageSize: 7,
      provenance: "LEARNED"
    });
  });

  it("rejects duplicate, unknown, and out-of-vocabulary filters", async () => {
    for (const query of [
      "category=WORK&category=GOALS",
      "category=PRIVATE",
      "provenance=ALL",
      "technicalState=READY"
    ]) {
      const fixture = dependencies();
      const response = await createListMemoryConsumerItemsHandler(fixture.deps)(
        new Request(`http://test/api/me/memories?${query}`)
      );
      expect(response.status).toBe(400);
      expect(fixture.list).not.toHaveBeenCalled();
    }
  });
});

describe("Memory consumer settings handlers", () => {
  const NOW = new Date("2026-10-02T10:00:00.000Z");
  const snapshot: MemorySettingsPersistenceSnapshot = {
    acceptedUtilityEgressAt: null, acceptedUtilityEgressFingerprint: null, acceptedUtilityPolicyVersion: null,
    activeIndexGenerationId: "generation-1", decayEnabled: false, decayPolicyVersion: null,
    embeddingProviderModelId: null, learnAutomatically: true, memoryConsentRevision: 0, memoryGeneration: 2,
    memoryRevision: 5, referenceChatHistory: true, sensitiveAutomaticPolicy: "EXPLICIT_ONLY", settingsRevision: 7,
    updatedAt: NOW, useMemoryFacts: true, userId: "user-1"
  };

  function compose() {
    const repository = {
      get: vi.fn(async () => snapshot),
      patch: vi.fn(async () => { throw new Error("unexpected_settings_write"); })
    };
    const service = createMemoryConsumerService({
      explicitService: {} as never,
      lifecycleService: {} as never,
      readResetState: async () => null,
      settingsService: createMemorySettingsService({
        repository,
        resolveCurrentUtilityPolicy: async () => ({
          destinations: [], fingerprint: "a".repeat(64),
          policyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION, targets: new Map()
        })
      })
    });
    return { deps: { resolveAuth: vi.fn(async () => ({ userId: "user-1" })), service } as never, repository };
  }

  it("reads the settings projection and rejects an unknown PATCH field without a write", async () => {
    const { deps, repository } = compose();
    const read = await createGetMemoryConsumerSettingsHandler(deps)(
      new Request("http://test/api/me/memory/settings")
    );
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ status: "ON" });

    const patched = await createPatchMemoryConsumerSettingsHandler(deps)(
      new Request("http://test/api/me/memory/settings", {
        body: JSON.stringify({ unknownSetting: true }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      })
    );
    expect(patched.status).toBe(400);
    await expect(patched.json()).resolves.toEqual({ error: "memory_contract_invalid" });
    expect(repository.patch).not.toHaveBeenCalled();
  });
});

describe("Memory consumer Forget handler", () => {
  const CANARY = "PRIVATE_CANARY_handler";

  afterEach(() => {
    vi.mocked(logEvent).mockReset();
  });

  async function forget(error: unknown) {
    const service = { forget: vi.fn(async () => { throw error; }) };
    const response = await createForgetMemoryConsumerItemHandler({
      resolveAuth: vi.fn(async () => ({ userId: "user-1" })),
      service
    } as never)(new Request("http://test/api/me/memories/opaque-ref/forget", {
      body: JSON.stringify({ requestId: "request-id-0000000001" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }), { params: { memoryId: "opaque-ref" } });
    return { response, service };
  }

  it("keeps the consumer's own diagnostic and safe status for mapped failures", async () => {
    const { response } = await forget(new MemoryConsumerServiceError("memory_action_failed"));
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({ error: "memory_action_failed" });
    expect(logEvent).not.toHaveBeenCalled();
  });

  it.each([
    [Object.assign(new Error(CANARY), { code: CANARY, name: CANARY, stack: CANARY }), "memory_forget_failed", "unknown"],
    [(() => {
      const error = new Prisma.PrismaClientKnownRequestError(CANARY, { clientVersion: "test", code: "P2028", meta: { statement: CANARY } });
      rememberDatabaseFailure(error, "P2028");
      return error;
    })(), "memory_forget_database_failed", "P2028"]
  ])("diagnoses an exception that escaped the consumer with a fixed category (%#)", async (error, code, prismaCode) => {
    vi.mocked(logEvent).mockImplementationOnce(() => { throw new Error(CANARY); });
    const { response, service } = await forget(error);
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "memory_action_failed" });
    expect(body).not.toContain(CANARY);
    expect(logEvent).toHaveBeenCalledExactlyOnceWith("service_operation", {
      action: "fail", code, outcome: "failed", prisma_code: prismaCode, stage: "delete", subsystem: "memory"
    });
    expect(service.forget).toHaveBeenCalledOnce();
  });
});
