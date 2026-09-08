import { describe, expect, it, vi } from "vitest";
import { ADMIN_PROVIDER_SETUP_STREAM_TYPE } from "../../../contracts/adminProviderSetupProgress";
import type { AdminProviderCustomSetupRequest } from "../../../contracts/adminProviderCustomSetup";
import { createAdminProviderCustomSetupHandler } from "./customSetupHandlers";
import { createAdminProviderQuickSetupMutationHandler } from "./quickSetupHandlers";
import { AdminProviderCustomSetupServiceError, createAdminProviderCustomSetupService } from "./customSetupService";
import { createAdminProviderQuickSetupService } from "./quickSetupService";
import { adminProviderQuickSetupPolicy } from "./quickSetupPolicy";
import { setupProgressResponse } from "./setupProgressResponse";
import type { AdminProviderDraftTesterInput } from "./tester";

const session = { expiresAt: new Date("2027-01-01"), id: "session", userId: "admin",
  user: { displayName: "Admin", email: "admin@example.test", id: "admin", role: "admin", status: "active" } };
const setupRequest: AdminProviderCustomSetupRequest = {
  allowPrivateNetwork: false, apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer",
  confirmPaidRequest: true, modelIds: ["model-a", "model-b", "model-c", "model-d"],
  protocol: "responses", responseTimeoutSeconds: 300, secret: "synthetic-secret"
};
function post(signal?: AbortSignal, body: unknown = setupRequest) {
  return new Request("http://localhost/api/admin/providers/custom-setup", {
    method: "POST", body: JSON.stringify(body), signal,
    headers: { accept: ADMIN_PROVIDER_SETUP_STREAM_TYPE, "content-type": "application/json" }
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function success(input: Pick<AdminProviderDraftTesterInput, "model" | "signal">) {
  return { status: "available" as const, evidence: { detail: "ok" as const, method: "tiny_generation" as const,
    selectedProviders: [], upstreamModelId: input.model.upstreamModelId } };
}
function collect(response: Response) {
  const events: Array<{ type: string; progress?: { phase: string; completed: number; total: number | null }; status?: number; data?: unknown }> = [];
  const reader = response.body!.getReader();
  const settled = (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      pending += decoder.decode(next.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) if (line) events.push(JSON.parse(line));
    }
  })();
  return { events, reader, settled };
}

describe("provider setup progress response", () => {
  it("streams all four model checks before commit, then distinguishes saving and finishing", async () => {
    const gates = Array.from({ length: 4 }, deferred);
    const committing = deferred();
    const finishing = deferred();
    const test = vi.fn(async (input: Pick<AdminProviderDraftTesterInput, "model" | "signal">) => {
      await gates[setupRequest.modelIds!.indexOf(input.model.upstreamModelId)]!.promise;
      return success(input);
    });
    const commit = vi.fn(async () => { await committing.promise; return { status: "ready" as const, defaultChanged: true }; });
    const onCompleted = vi.fn(async () => { await finishing.promise; });
    const service = createAdminProviderCustomSetupService({ tester: { test }, repository: { commit }, onCompleted,
      encryptionKey: () => Buffer.alloc(32, 12) });
    const response = await createAdminProviderCustomSetupHandler({ resolveAuth: async () => session, service })(post());
    expect(response.headers.get("content-type")).toContain(ADMIN_PROVIDER_SETUP_STREAM_TYPE);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(test).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    const stream = collect(response);
    for (let index = 0; index < 4; index += 1) {
      await vi.waitFor(() => expect(stream.events).toContainEqual({ type: "progress",
        progress: { phase: "checking", completed: index, total: 4 } }));
      expect(stream.events.some(({ type }) => type === "result")).toBe(false);
      gates[index]!.resolve();
      await vi.waitFor(() => expect(stream.events).toContainEqual({ type: "progress",
        progress: { phase: "checking", completed: index + 1, total: 4 } }));
    }
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(stream.events.at(-1)?.progress?.phase).toBe("saving");
    expect(onCompleted).not.toHaveBeenCalled();
    committing.resolve();
    await vi.waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());
    expect(stream.events.at(-1)?.progress?.phase).toBe("finishing");
    expect(stream.events.some(({ type }) => type === "result")).toBe(false);
    finishing.resolve();
    await stream.settled;
    expect(stream.events.at(-1)).toMatchObject({ type: "result", status: 200, data: { outcome: "ready", models: expect.any(Array) } });
    expect(test).toHaveBeenCalledTimes(4);
    const progress = JSON.stringify(stream.events.filter(({ type }) => type === "progress"));
    expect(progress).not.toContain("synthetic-secret");
    expect(progress).not.toContain("provider.example.test");
    expect(progress).not.toContain("model-a");
  });

  it("streams quick setup catalog discovery before its deferred response and final commit", async () => {
    const catalog = deferred();
    const saving = deferred();
    const candidate = adminProviderQuickSetupPolicy("openai").candidates[0]!;
    const commit = vi.fn(async () => {
      await saving.promise;
      return { status: "ready" as const, defaultChanged: true, defaultCredentialChanged: true, search: null };
    });
    const service = createAdminProviderQuickSetupService({
      encryptionKey: () => Buffer.alloc(32, 13), stateTokenKey: () => Buffer.alloc(32, 14),
      repository: {
        async inspect({ provider }) { return { actingUserDefault: false, authorized: true, canonicalConnection: false,
          configured: false, connectionNames: [], fingerprint: `synthetic-${provider}`, mode: "initial", model: null,
          preservedModels: [], quickSetupAssignment: null, quickSetupCredential: null, provider, state: "not_configured" }; },
        commit, async commitAdditional() { throw new Error("unexpected_additional_commit"); }
      },
      credentialTester: { async test() { await catalog.promise; return { method: "models_catalog", modelIds: [candidate.configuration.upstreamModelId] }; } },
      pdfInputProbe: { async probe() { return null; } }
    });
    const snapshot = await service.getSnapshot({ sessionId: "session", userId: "admin" });
    const response = await createAdminProviderQuickSetupMutationHandler({ resolveAuth: async () => session, service })(post(undefined, {
      provider: "openai", secret: "synthetic-secret", expectedState: snapshot.providers.find(({ provider }) => provider === "openai")!.stateToken
    }));
    const stream = collect(response);
    await vi.waitFor(() => expect(stream.events).toContainEqual({ type: "progress", progress: { phase: "discovering", completed: 0, total: null } }));
    expect(commit).not.toHaveBeenCalled();
    catalog.resolve();
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(stream.events).toContainEqual({ type: "progress", progress: { phase: "checking", completed: 1, total: 1 } });
    expect(stream.events.at(-1)?.progress?.phase).toBe("saving");
    saving.resolve();
    await stream.settled;
    expect(stream.events).toContainEqual({ type: "progress", progress: { phase: "finishing", completed: 0, total: null } });
    expect(stream.events.at(-1)).toMatchObject({ type: "result", status: 200, data: { outcome: "ready" } });
  });

  it.each(["before_start", "during_probe", "after_last_probe"] as const)("does not commit after cancellation %s", async (when) => {
    const controller = new AbortController();
    const started = deferred();
    const release = deferred();
    const test = vi.fn(async (input: Pick<AdminProviderDraftTesterInput, "model" | "signal">) => {
      started.resolve();
      if (when === "during_probe") {
        await new Promise<void>((_resolve, reject) => input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true }));
      } else if (when === "after_last_probe") {
        await release.promise;
        controller.abort("synthetic_cancelled");
      }
      return success(input);
    });
    const commit = vi.fn(async () => ({ status: "ready" as const, defaultChanged: true }));
    const onCompleted = vi.fn();
    const service = createAdminProviderCustomSetupService({ tester: { test }, repository: { commit }, onCompleted,
      encryptionKey: () => Buffer.alloc(32, 12) });
    if (when === "before_start") controller.abort("synthetic_cancelled");
    const operation = service.setup({ actor: { sessionId: "session", userId: "admin" },
      request: { ...setupRequest, modelIds: ["model-a"] }, signal: controller.signal });
    const rejected = expect(operation).rejects.toBeDefined();
    if (when !== "before_start") {
      await started.promise;
      if (when === "during_probe") controller.abort("synthetic_cancelled");
      else release.resolve();
    }
    await rejected;
    expect(commit).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
    expect(test).toHaveBeenCalledTimes(when === "before_start" ? 0 : 1);
  });

  it("propagates reader disconnect to the active probe and prevents saving", async () => {
    const started = deferred();
    const aborted = deferred();
    const commit = vi.fn(async () => ({ status: "ready" as const, defaultChanged: true }));
    const service = createAdminProviderCustomSetupService({ repository: { commit }, tester: {
      async test(input) {
        started.resolve();
        await new Promise<void>((_resolve, reject) => input.signal!.addEventListener("abort", () => {
          aborted.resolve(); reject(input.signal!.reason);
        }, { once: true }));
        return success(input);
      }
    } });
    const response = await createAdminProviderCustomSetupHandler({ resolveAuth: async () => session, service })(post());
    const reader = response.body!.getReader();
    await started.promise;
    await reader.cancel();
    await aborted.promise;
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(["custom", "quick"] as const)("authenticates %s before starting an operation or emitting events", async (kind) => {
    const setup = vi.fn(async () => { throw new Error("must_not_run"); });
    const handler = kind === "custom"
      ? createAdminProviderCustomSetupHandler({ resolveAuth: async () => null, service: { setup } })
      : createAdminProviderQuickSetupMutationHandler({ resolveAuth: async () => null, service: { setup, getSnapshot: vi.fn() } });
    const response = await handler(post());
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(setup).not.toHaveBeenCalled();
  });

  it("delivers an initial safe terminal service error without claiming progress or success", async () => {
    const response = await createAdminProviderCustomSetupHandler({ resolveAuth: async () => session,
      service: { async setup() { throw new AdminProviderCustomSetupServiceError("provider_custom_setup_test_failed"); } }
    })(post());
    const stream = collect(response);
    await stream.settled;
    expect(stream.events).toEqual([{ type: "result", status: 422, data: { error: "provider_custom_setup_test_failed" } }]);
  });

  it("maps an unexpected operation rejection to a content-free terminal event", async () => {
    const response = await setupProgressResponse(post(), async () => { throw new Error("PRIVATE_UPSTREAM_DETAIL"); });
    const stream = collect(response);
    await stream.settled;
    expect(stream.events).toEqual([{ type: "result", status: 500, data: { error: "provider_setup_interrupted" } }]);
  });
});
