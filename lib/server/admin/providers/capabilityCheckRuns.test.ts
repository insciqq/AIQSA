import { describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_CHECK_CANCELLED,
  createCapabilityCheckRunner,
  type CapabilityCheckOutcome,
  type CapabilityCheckRequest
} from "./capabilityCheckRuns";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("capability check runner", () => {
  it.each([3, 4])("projects %i reused receipts without repeating their checks", async (count) => {
    const ids = ["a", "b", "c", "d"];
    const check = vi.fn(async (request: CapabilityCheckRequest) => {
      request.onResult?.({ providerModelId: request.providerModelId, state: "saved", checks: { modelAccess: "verified" } });
      return "stored" as const;
    });
    const runner = createCapabilityCheckRunner({ check });
    const run = runner.start({ connectionId: "connection", credentialId: "key", modelIds: ids, reason: "setup",
      reusedResults: ids.slice(0, count).map((providerModelId) => ({ providerModelId, state: "saved", checks: { modelAccess: "verified" } })) });
    await run.settled;
    expect(check).toHaveBeenCalledTimes(4 - count);
    expect(runner.get(run.id)).toMatchObject({ done: 4, total: 4, state: "completed" });
    expect(runner.get(run.id)?.results).toHaveLength(4);
    expect(runner.get(run.id)?.results?.every((result) => result.state === "saved")).toBe(true);
  });

  it("does not turn an unsaved or foreign receipt into reused proof", async () => {
    const check = vi.fn(async () => "failed" as const);
    const runner = createCapabilityCheckRunner({ check });
    const run = runner.start({ connectionId: "connection", credentialId: "key", modelIds: ["a"], reason: "setup",
      reusedResults: [{ providerModelId: "a", state: "save_failed" }, { providerModelId: "foreign", state: "saved" }] });
    await run.settled;
    expect(check).toHaveBeenCalledOnce();
    expect(runner.get(run.id)?.results).toEqual([]);
  });
  it("keeps a selected catalog batch independent of older failures and copies its retry identities", async () => {
    const runner = createCapabilityCheckRunner({ check: async ({ providerModelId }) => providerModelId === "old" ? "failed" : "stored" });
    await runner.start({ connectionId: "connection", credentialId: "key", modelIds: ["old"], reason: "requested" }).settled;
    const ids = ["builtin-new"];
    const run = runner.start({ connectionId: "connection", credentialId: "key", modelIds: ["new"], catalogModelIds: ids, reason: "requested" });
    ids.push("unselected");
    await run.settled;
    const result = runner.get(run.id)!;
    expect(result).toMatchObject({ catalogModelIds: ["builtin-new"], failed: [], total: 1, done: 1 });
    result.catalogModelIds!.push("mutated");
    expect(runner.get(run.id)!.catalogModelIds).toEqual(["builtin-new"]);
    expect(result.setup).toBeUndefined();
  });

  it("keeps setup visible and cancellable after models finish, and never completes setup for an empty inventory", async () => {
    const runner = createCapabilityCheckRunner({ check: async () => "stored" });
    const started = deferred<AbortSignal>();
    const completeSetup = vi.fn(async (signal: AbortSignal) => {
      started.resolve(signal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { defaults: [], search: "ready" as const, state: "completed" as const };
    });
    const empty = runner.start({ connectionId: "empty", credentialId: "key", modelIds: [], reason: "setup", completeSetup });
    await empty.settled;
    expect(completeSetup).not.toHaveBeenCalled();
    const run = runner.start({ connectionId: "connection", credentialId: "key", modelIds: ["model"], reason: "setup", completeSetup });
    const signal = await started.promise;
    expect(runner.get(run.id)).toMatchObject({ state: "running", done: 1, total: 1, setup: { state: "running" } });
    expect(runner.cancel(run.id)).toBe(true);
    expect(signal.aborted).toBe(true);
    await run.settled;
    expect(runner.get(run.id)?.state).toBe("cancelled");
    expect(runner.get(run.id)?.setup).not.toHaveProperty("search", "ready");
  });

  it("reports skipped models and partial automatic setup without losing completed model results", async () => {
    const runner = createCapabilityCheckRunner({ check: async ({ providerModelId }) => providerModelId === "stale" ? "skipped" : "stored" });
    const run = runner.start({ connectionId: "connection", credentialId: "key", modelIds: ["ready", "stale"], reason: "setup",
      completeSetup: async () => ({ defaults: ["Chat: Ready"], search: "failed", state: "partial" }) });
    await run.settled;
    expect(runner.get(run.id)).toMatchObject({ state: "completed", done: 2, skipped: ["stale"],
      setup: { defaults: ["Chat: Ready"], search: "failed", state: "partial" } });
  });

  it("runs at most three checks per connection at once and reports progress content-free", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<CapabilityCheckOutcome>>>();
    let peak = 0;
    let active = 0;
    const runner = createCapabilityCheckRunner({
      async check(request: CapabilityCheckRequest) {
        active += 1;
        peak = Math.max(peak, active);
        const gate = deferred<CapabilityCheckOutcome>();
        gates.set(request.providerModelId, gate);
        try {
          return await gate.promise;
        } finally {
          active -= 1;
        }
      },
      idFactory: () => "run-1",
      now: () => new Date("2026-09-07T12:51:00.000Z")
    });

    const { id, settled } = runner.start({
      connectionId: "conn-1",
      credentialId: "cred-1",
      modelIds: ["m1", "m2", "m3", "m4", "m5"],
      reason: "credential"
    });
    await settle();
    expect(id).toBe("run-1");
    expect(peak).toBe(3);
    expect(runner.get(id)).toMatchObject({
      credentialId: "cred-1",
      current: "m1",
      done: 0,
      failed: [],
      inFlight: ["m1", "m2", "m3"],
      reason: "credential",
      startedAt: "2026-09-07T12:51:00.000Z",
      state: "running",
      total: 5
    });
    expect(runner.latest("conn-1")?.id).toBe("run-1");
    expect(runner.running("conn-1", "cred-1")?.id).toBe("run-1");
    expect(runner.running("conn-1", "cred-other")).toBeNull();

    gates.get("m2")!.resolve("failed");
    await settle();
    expect(runner.get(id)).toMatchObject({ done: 1, failed: ["m2"], inFlight: ["m1", "m3", "m4"] });
    expect(peak).toBe(3);

    gates.get("m1")!.resolve("stored");
    gates.get("m3")!.resolve("skipped");
    gates.get("m4")!.resolve("stored");
    await settle();
    gates.get("m5")!.resolve("stored");
    await settled;
    expect(runner.get(id)).toMatchObject({
      current: null,
      done: 5,
      failed: ["m2"],
      finishedAt: "2026-09-07T12:51:00.000Z",
      inFlight: [],
      state: "completed"
    });
    expect(runner.running("conn-1", "cred-1")).toBeNull();
    expect(runner.latest("conn-1")?.state).toBe("completed");
    expect(JSON.stringify(runner.get(id))).not.toMatch(/secret|evidence|token/iu);
  });

  it("clears a remembered failure once a later check of the same model stores evidence", async () => {
    const outcomes: CapabilityCheckOutcome[] = ["failed", "stored"];
    const runner = createCapabilityCheckRunner({
      async check() { return outcomes.shift() ?? "skipped"; }
    });
    const first = runner.start({ connectionId: "c", credentialId: "k", modelIds: ["m"], reason: "model" });
    await first.settled;
    expect(runner.get(first.id)?.failed).toEqual(["m"]);
    const second = runner.start({ connectionId: "c", credentialId: "k", modelIds: ["m"], reason: "model" });
    await second.settled;
    expect(runner.get(second.id)?.failed).toEqual([]);
    expect(runner.get(first.id)?.failed).toEqual([]);
  });

  it("cancels the queue and aborts in-flight checks without recording them as failures", async () => {
    const seen: string[] = [];
    const signals = new Map<string, AbortSignal>();
    const gate = deferred<CapabilityCheckOutcome>();
    const runner = createCapabilityCheckRunner({
      async check(request) {
        seen.push(request.providerModelId);
        signals.set(request.providerModelId, request.signal);
        await gate.promise;
        if (request.signal.aborted) throw new Error("aborted");
        return "stored";
      },
      concurrency: 1
    });
    const { id, settled } = runner.start({
      connectionId: "conn-1",
      credentialId: "cred-1",
      modelIds: ["m1", "m2", "m3"],
      reason: "requested"
    });
    await settle();
    expect(seen).toEqual(["m1"]);
    expect(runner.cancel(id)).toBe(true);
    expect(signals.get("m1")?.aborted).toBe(true);
    expect(signals.get("m1")?.reason).toBe(CAPABILITY_CHECK_CANCELLED);
    gate.resolve("stored");
    await settled;
    expect(seen).toEqual(["m1"]);
    expect(runner.get(id)).toMatchObject({ done: 1, failed: [], inFlight: [], state: "cancelled", total: 3 });
    expect(runner.cancel(id)).toBe(false);
  });

  it("reports an id it never saw as interrupted so a restart can be restarted from the page", () => {
    const runner = createCapabilityCheckRunner({ async check() { return "stored"; } });
    expect(runner.get("gone")).toBeNull();
    expect(runner.connectionOf("gone")).toBeNull();
    expect(runner.interrupted("gone")).toMatchObject({ done: 0, id: "gone", state: "interrupted", total: 0 });
    expect(runner.latest("conn-1")).toBeNull();
  });

  it("prefers the running run of a connection over finished ones", async () => {
    const gate = deferred<CapabilityCheckOutcome>();
    let calls = 0;
    const runner = createCapabilityCheckRunner({
      async check() {
        calls += 1;
        return calls === 1 ? "stored" : gate.promise;
      },
      idFactory: () => `run-${calls + 1}`
    });
    const first = runner.start({ connectionId: "c", credentialId: "k", modelIds: ["m"], reason: "model" });
    await first.settled;
    const second = runner.start({ connectionId: "c", credentialId: "k", modelIds: ["m"], reason: "requested" });
    await settle();
    expect(runner.latest("c")?.id).toBe(second.id);
    expect(runner.connectionOf(second.id)).toBe("c");
    gate.resolve("stored");
    await second.settled;
    expect(runner.latest("c")?.id).toBe(second.id);
  });
});
