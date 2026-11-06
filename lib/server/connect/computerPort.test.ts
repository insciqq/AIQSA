import { COMPUTER_ERROR_CODES, COMPUTER_FAILURE_CODES, COMPUTER_REFUSALS } from "@/lib/contracts/computer";
import { CONNECT_OP_ERROR_CODES } from "@/lib/contracts/connect";
import failureCodes from "../observability/failureCodes.json";
import { createFakeComputerOps, getComputerOps, setComputerOps, type ComputerOpCall } from "./computerPort";

const USER = "user-1";
const DEVICE = "0b6f1c2e-6a49-4c3e-9a51-3f1f0d2b7c11";
const RUN = "1679091c-5a88-4faf-afb5-e6087eb1b2dc";

function readCall(signal = new AbortController().signal): ComputerOpCall<"read"> {
  return {
    args: { cwd: "~", limit: 2000, offset: 1, path: "notes.txt" },
    deviceId: DEVICE,
    op: "read",
    runId: RUN,
    signal,
    timeoutMs: 60_000,
    userId: USER
  };
}

const readResult = { content: "hello\n", encoding: "utf-8", lineEnding: "lf", startLine: 1, totalLines: 1, truncated: false } as const;

afterEach(() => setComputerOps(null));

describe("computer port", () => {
  it("answers only registered stable codes", () => {
    const registered = new Set<string>(failureCodes);
    const codes = [...COMPUTER_FAILURE_CODES, ...CONNECT_OP_ERROR_CODES, ...Object.values(COMPUTER_REFUSALS), ...COMPUTER_ERROR_CODES];
    expect(codes.filter((code) => !registered.has(code))).toEqual([]);
  });

  it("is unavailable until the relay installs its implementation", async () => {
    const ops = getComputerOps();
    await expect(ops.call(readCall())).resolves.toEqual({ code: "connect_device_offline", ok: false, sent: false });
    await expect(ops.describe(USER, DEVICE)).resolves.toBeNull();
    expect(() => ops.runEnded({ deviceId: DEVICE, runId: RUN, userId: USER })).not.toThrow();

    const fake = createFakeComputerOps();
    setComputerOps(fake);
    expect(getComputerOps()).toBe(fake);
    setComputerOps(null);
    expect(getComputerOps()).not.toBe(fake);
  });
});

describe("fake computer ops", () => {
  it("answers scripted outcomes per op in order and records the calls", async () => {
    const fake = createFakeComputerOps();
    fake.enqueue({ code: "computer_edit_ambiguous", ok: false, sent: true }, "edit");
    fake.enqueue({ ok: true, result: readResult });
    await expect(fake.call(readCall())).resolves.toEqual({ ok: true, result: readResult });
    await expect(fake.call(readCall())).resolves.toEqual({ code: "connect_device_offline", ok: false, sent: false });
    expect(fake.calls).toEqual([
      { aborted: false, args: readCall().args, deviceId: DEVICE, op: "read", runId: RUN, timeoutMs: 60_000, userId: USER },
      expect.objectContaining({ aborted: false, op: "read" })
    ]);
    expect(fake.calls[0]).not.toHaveProperty("signal");

    fake.runEnded({ deviceId: DEVICE, runId: RUN, userId: USER });
    expect(fake.endedRuns).toEqual([{ deviceId: DEVICE, runId: RUN, userId: USER }]);
  });

  it("lets a handler see the call and answers computer_cancelled on abort", async () => {
    const fake = createFakeComputerOps();
    let seen: ComputerOpCall | null = null;
    fake.enqueue((call) => {
      seen = call;
      return new Promise<never>(() => undefined);
    });
    const controller = new AbortController();
    const pending = fake.call(readCall(controller.signal));
    await Promise.resolve();
    expect(seen).toMatchObject({ op: "read", runId: RUN });
    controller.abort();
    await expect(pending).resolves.toEqual({ code: "computer_cancelled", ok: false, sent: true });
    expect(fake.calls[0]!.aborted).toBe(true);

    const aborted = new AbortController();
    aborted.abort();
    fake.enqueue({ ok: true, result: readResult });
    await expect(fake.call(readCall(aborted.signal))).resolves.toEqual({ code: "computer_cancelled", ok: false, sent: true });
    expect(fake.calls[1]!.aborted).toBe(true);
  });

  it("describes only the devices it was given, per user", async () => {
    const fake = createFakeComputerOps();
    const description = { arch: "amd64", name: "DESKTOP-7Q2", online: false, os: "windows" } as const;
    fake.setDevice(USER, DEVICE, description);
    await expect(fake.describe(USER, DEVICE)).resolves.toEqual(description);
    await expect(fake.describe("user-2", DEVICE)).resolves.toBeNull();
    fake.setDevice(USER, DEVICE, null);
    await expect(fake.describe(USER, DEVICE)).resolves.toBeNull();
  });
});
