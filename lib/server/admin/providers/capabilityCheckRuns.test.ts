import { describe, expect, it } from "vitest";
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
