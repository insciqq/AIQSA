// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { COMPUTER_REFUSALS } from "@/lib/contracts/computer";
import { createFakeComputerOps } from "../connect/computerPort";
import { freezeComputerBinding } from "../tools/computerBinding";
import { admitComputer, type ComputerAdmissionDeps, type ComputerAdmissionInput } from "./computerAdmission";

const USER = "user-1";
const MINE = "0b6f1c2e-6a49-4c3e-9a51-3f1f0d2b7c11";
const THEIRS = "5d2c9a8e-1b3f-4e6a-9c7d-2e4f6a8b0c1d";
const MISSING = "9e8d7c6b-5a49-4382-a1b2-c3d4e5f60718";
const description = { arch: "arm64", name: "MacBook", online: false, os: "darwin" } as const;

function deps(enabled = true): ComputerAdmissionDeps & { fake: ReturnType<typeof createFakeComputerOps> } {
  const fake = createFakeComputerOps();
  fake.setDevice(USER, MINE, description);
  fake.setDevice("user-2", THEIRS, { ...description, name: "Someone else's" });
  return { describe: (userId, deviceId) => fake.describe(userId, deviceId), enabled: vi.fn(async () => enabled), fake };
}

const send = (field: unknown, overrides: Partial<ComputerAdmissionInput> = {}): ComputerAdmissionInput => ({
  assistantChat: false, field, origin: "interactive", userId: USER, ...overrides
});

describe("a message's computer", () => {
  it("runs without one and leaves the chat's choice when the field is absent, and clears that choice for null", async () => {
    await expect(admitComputer(deps(), send(undefined, { stored: { cwd: "~", deviceId: MINE } })))
      .resolves.toEqual({ binding: null, guidance: null, ok: true });
    await expect(admitComputer(deps(), send(null))).resolves.toEqual({ binding: null, chatChoice: null, guidance: null, ok: true });
  });

  it("freezes the user's own computer, offline included, stores the choice and writes the turn line", async () => {
    const admitted = await admitComputer(deps(), send({ cwd: "~/Documents", deviceId: MINE }));
    expect(admitted).toEqual({ binding: freezeComputerBinding({ cwd: "~/Documents", deviceId: MINE }, description),
      chatChoice: { cwd: "~/Documents", deviceId: MINE }, guidance: expect.stringContaining("was offline when this message was sent"),
      ok: true });
  });

  it("answers a computer that is gone exactly as one that is someone else's", async () => {
    const theirs = await admitComputer(deps(), send({ cwd: "~", deviceId: THEIRS }));
    const missing = await admitComputer(deps(), send({ cwd: "~", deviceId: MISSING }));
    expect(theirs).toEqual({ code: COMPUTER_REFUSALS.unavailable, ok: false, status: 409 });
    expect(missing).toEqual(theirs);
  });

  it("refuses while AIQSA Connect is off, a malformed field, and where a computer is never available", async () => {
    const off = deps(false);
    await expect(admitComputer(off, send({ cwd: "~", deviceId: MINE }))).resolves.toEqual({ code: "connect_disabled", ok: false, status: 409 });
    await expect(admitComputer(undefined, send({ cwd: "~", deviceId: MINE }))).resolves.toMatchObject({ code: "connect_disabled" });
    for (const field of [{ cwd: "~", deviceId: MINE, extra: 1 }, { cwd: "a\u0007b", deviceId: MINE }, "computer", { cwd: "x".repeat(1_025), deviceId: MINE }]) {
      await expect(admitComputer(deps(), send(field))).resolves.toEqual({ code: COMPUTER_REFUSALS.invalid, ok: false, status: 400 });
    }
    const notHere = { code: COMPUTER_REFUSALS.notHere, ok: false, status: 409 };
    await expect(admitComputer(deps(), send({ cwd: "~", deviceId: MINE }, { assistantChat: true }))).resolves.toEqual(notHere);
    for (const origin of ["telegram", "scheduled", "wake_up"] as const) {
      const checked = deps();
      await expect(admitComputer(checked, send({ cwd: "~", deviceId: MINE }, { origin }))).resolves.toEqual(notHere);
      expect(checked.enabled).not.toHaveBeenCalled();
    }
  });

  it("tells a turn that cannot use the chat's chosen computer so, and changes no choice from there", async () => {
    const stored = { cwd: "~", deviceId: MINE };
    const telegram = await admitComputer(deps(), send(undefined, { origin: "telegram", stored }));
    expect(telegram).toEqual({ binding: null, guidance: expect.stringContaining("not available from Telegram"), ok: true });
    await expect(admitComputer(deps(), send(null, { origin: "scheduled", stored }))).resolves.toEqual({ binding: null,
      guidance: expect.stringContaining("not available in automations"), ok: true });
    await expect(admitComputer(deps(), send(undefined, { origin: "wake_up", stored: null }))).resolves.toEqual({ binding: null,
      guidance: null, ok: true });
  });

  it("repeats the run's own binding on a regenerate, whatever the request says, and changes no choice", async () => {
    const frozen = freezeComputerBinding({ cwd: "~/Projects", deviceId: MINE }, { ...description, online: true })!;
    const repeated = await admitComputer(deps(), send({ cwd: "~/Other", deviceId: MINE }, { frozen }));
    expect(repeated).toMatchObject({ binding: { cwd: "~/Projects", deviceId: MINE, online: false }, ok: true });
    expect(repeated).not.toHaveProperty("chatChoice");
    await expect(admitComputer(deps(), send({ cwd: "~", deviceId: MINE }, { frozen: null }))).resolves.toEqual({ binding: null, guidance: null,
      ok: true });
    // The device is checked again: a regenerate never runs on a computer that is gone.
    const gone = freezeComputerBinding({ cwd: "~", deviceId: MISSING }, description)!;
    await expect(admitComputer(deps(), send(undefined, { frozen: gone }))).resolves.toMatchObject({ code: COMPUTER_REFUSALS.unavailable });
  });
});
