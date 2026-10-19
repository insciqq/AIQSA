import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeTelegramBotApi, FAKE_TELEGRAM_TOKEN, type FakeTelegramBotApi } from "@/tests/support/fakeTelegramBotApi";
import { captureRunObservation } from "@/tests/support/runObservation";
import { createTelegramBotApi, createTelegramPacer, type TelegramBotApi } from "../botApi";
import { TELEGRAM_BOT_COMMANDS } from "../copy";
import { createTelegramControlHooks } from "./hooks";
import type { TelegramControlRecord, TelegramControlRepository } from "./repository";
import { createTelegramControlService } from "./service";
import { createTelegramControlCache, effectiveTelegramControl } from "./state";
import { decryptTelegramBotToken, encryptTelegramBotToken } from "./tokenEnvelope";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const GROUP = "8a4f2a8e-5a8b-4c55-9c1e-0d4a1f6f9b10";
const ARCHIVED_GROUP = "9b5f3b9f-6b9c-4d66-8d2f-1e5b2a7a0c21";
const SECRET = FAKE_TELEGRAM_TOKEN.split(":")[1]!;

type Seed = Partial<TelegramControlRecord> | ((key: Buffer, fake: FakeTelegramBotApi) => Partial<TelegramControlRecord>);

/** An in-memory control row with the repository's version and token rules. */
function memoryRepository(initial: Partial<TelegramControlRecord>) {
  let record: TelegramControlRecord = {
    botId: null, botUsername: null, enabled: false, groupIds: [], lastFailureAt: null, lastFailureCode: null, lastPollAt: null,
    lastSuccessAt: null, restricted: false, tokenEnvelope: null, tokenGeneration: 0, version: 1, ...initial
  };
  type Change = TelegramControlRecord | Readonly<{ kind: "token_missing" | "groups_invalid" }>;
  const write = (expectedVersion: number, change: (current: TelegramControlRecord) => Change) => {
    if (record.version !== expectedVersion) return { kind: "stale" } as const;
    const next = change(record);
    if ("kind" in next) return next;
    record = { ...next, version: record.version + 1 };
    return { kind: "ok", record } as const;
  };
  const repository: TelegramControlRepository = {
    read: vi.fn(async () => record),
    saveToken: vi.fn(async (input) => write(input.expectedVersion, (current) => ({
      ...current, botId: input.botId, botUsername: input.botUsername, lastFailureAt: null, lastFailureCode: null, lastPollAt: null,
      lastSuccessAt: null, tokenEnvelope: input.seal(current.tokenGeneration + 1), tokenGeneration: current.tokenGeneration + 1
    }))),
    setEnabled: vi.fn(async (input) => write(input.expectedVersion, (current) =>
      input.enabled && current.tokenEnvelope === null ? { kind: "token_missing" } : { ...current, enabled: input.enabled })),
    setAccess: vi.fn(async (input) => write(input.expectedVersion, (current) => input.groupIds.some((id: string) => id !== GROUP)
      ? { kind: "groups_invalid" } : { ...current, groupIds: [...input.groupIds], restricted: input.restricted })),
    recordPollHealth: vi.fn(async () => {})
  };
  return { get record() { return record; }, repository };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

function setup(seed: Seed = {}, options: Readonly<{ key?: () => Buffer; deadlineMs?: number }> = {}) {
  const fake = createFakeTelegramBotApi();
  closers.push(() => fake.close());
  const key = randomBytes(32);
  const memory = memoryRepository(typeof seed === "function" ? seed(key, fake) : seed);
  const hooks = createTelegramControlHooks();
  const changed = vi.fn();
  hooks.onChange(changed);
  const snapshots = createTelegramControlCache({ load: async () => effectiveTelegramControl(memory.record, () => key) });
  const invalidate = vi.fn(() => snapshots.invalidate());
  const cache = { get: () => snapshots.get(), invalidate };
  const apis: string[] = [];
  const createBotApi = (token: string): TelegramBotApi => {
    apis.push(token);
    return createTelegramBotApi({ pacer: createTelegramPacer({ now: () => 0 }), sleep: async () => {}, token, transport: fake.transport });
  };
  const service = createTelegramControlService({
    cache, createBotApi, deadlineMs: options.deadlineMs, encryptionKey: options.key ?? (() => key), hooks, repository: memory.repository
  });
  return { apis, changed, fake, hooks, invalidate, key, memory, service };
}

function configured(key: Buffer, fake: FakeTelegramBotApi, overrides: Partial<TelegramControlRecord> = {}): Partial<TelegramControlRecord> {
  return {
    botId: fake.bot.id, botUsername: fake.bot.username, tokenEnvelope: encryptTelegramBotToken({ generation: 1, key, token: fake.token }),
    tokenGeneration: 1, ...overrides
  };
}

describe("Telegram control service: Test & Save", () => {
  it("stores nothing when Telegram rejects the token and keeps the token out of every log record", async () => {
    const capture = await captureRunObservation();
    const { changed, fake, memory, service } = setup();
    fake.failNext("getMe", { description: `Unauthorized ${FAKE_TELEGRAM_TOKEN}`, status: 401 });
    await expect(service.testAndSave({ actorUserId: ADMIN, expectedVersion: 1, token: FAKE_TELEGRAM_TOKEN }))
      .resolves.toEqual({ code: "telegram_token_rejected", ok: false });
    expect(memory.repository.saveToken).not.toHaveBeenCalled();
    expect(memory.record).toMatchObject({ tokenEnvelope: null, version: 1 });
    expect(changed).not.toHaveBeenCalled();
    fake.failNext("getMe", { drop: true });
    await expect(service.testAndSave({ actorUserId: ADMIN, expectedVersion: 1, token: FAKE_TELEGRAM_TOKEN }))
      .resolves.toEqual({ code: "telegram_unreachable", ok: false });
    const logged = JSON.stringify(capture.records());
    expect(logged).toContain("telegram_token_rejected");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("api.telegram.org");
  });

  it("saves the envelope and bot identity only after getMe proves the token, and never returns the token", async () => {
    const { apis, changed, fake, invalidate, key, memory, service } = setup();
    const result = await service.testAndSave({ actorUserId: ADMIN, expectedVersion: 1, token: FAKE_TELEGRAM_TOKEN });
    expect(result).toEqual({
      ok: true,
      state: {
        botUsername: fake.bot.username, enabled: false, groupIds: [],
        health: { lastFailureAt: null, lastFailureCode: null, lastPollAt: null, lastSuccessAt: null },
        restricted: false, tokenConfigured: true, version: 2
      }
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(memory.record).toMatchObject({ botId: fake.bot.id, botUsername: fake.bot.username, tokenGeneration: 1 });
    expect(memory.record.tokenEnvelope).not.toContain(SECRET);
    expect(decryptTelegramBotToken({ envelope: memory.record.tokenEnvelope!, generation: 1, key })).toBe(FAKE_TELEGRAM_TOKEN);
    expect(fake.calls().map((call) => call.method)).toEqual(["getMe"]);
    expect(apis).toEqual([FAKE_TELEGRAM_TOKEN]);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("refuses a stale version or a missing encryption key before calling Telegram", async () => {
    const stale = setup({ version: 4 });
    await expect(stale.service.testAndSave({ actorUserId: ADMIN, expectedVersion: 3, token: FAKE_TELEGRAM_TOKEN }))
      .resolves.toEqual({ code: "telegram_control_stale", ok: false });
    expect(stale.fake.calls()).toHaveLength(0);
    const keyless = setup({}, { key: () => { throw new Error("AIQSA_ENCRYPTION_KEY missing"); } });
    await expect(keyless.service.testAndSave({ actorUserId: ADMIN, expectedVersion: 1, token: FAKE_TELEGRAM_TOKEN }))
      .resolves.toEqual({ code: "telegram_encryption_unavailable", ok: false });
    expect(keyless.fake.calls()).toHaveLength(0);
  });

  it("gives up after the hard deadline, and refuses a token whose getMe names another bot", async () => {
    const slow = setup({}, { deadlineMs: 30 });
    slow.fake.failNext("getMe", { delayMs: 200 });
    await expect(slow.service.testAndSave({ actorUserId: ADMIN, expectedVersion: 1, token: FAKE_TELEGRAM_TOKEN }))
      .resolves.toEqual({ code: "telegram_unreachable", ok: false });
    expect(slow.memory.repository.saveToken).not.toHaveBeenCalled();

    const memory = memoryRepository({});
    const service = createTelegramControlService({
      cache: createTelegramControlCache({ load: async () => effectiveTelegramControl(memory.record, () => randomBytes(32)) }),
      createBotApi: () => ({
        getMe: async () => ({ ok: true, result: { first_name: "Other", id: 42, is_bot: true, username: "other_bot" } })
      }) as unknown as TelegramBotApi,
      encryptionKey: () => randomBytes(32), hooks: createTelegramControlHooks(), repository: memory.repository
    });
    await expect(service.testAndSave({ actorUserId: ADMIN, expectedVersion: 1, token: FAKE_TELEGRAM_TOKEN }))
      .resolves.toEqual({ code: "telegram_token_rejected", ok: false });
    expect(memory.repository.saveToken).not.toHaveBeenCalled();
  });

  it("takes the bot over at once when its token is saved again while the bot is on", async () => {
    const { fake, memory, service } = setup((key, bot) => configured(key, bot, { enabled: true }));
    const result = await service.testAndSave({ actorUserId: ADMIN, expectedVersion: 1, token: fake.token });
    expect(result).toMatchObject({ ok: true, state: { enabled: true, tokenConfigured: true, version: 2 } });
    expect(memory.record.tokenGeneration).toBe(2);
    expect(fake.calls().map((call) => call.method)).toEqual(["getMe", "deleteWebhook", "setMyCommands"]);
  });
});

describe("Telegram control service: enable, disable and access", () => {
  it("enables only with a readable stored token, after deleteWebhook and setMyCommands, then runs the activation hooks", async () => {
    await expect(setup().service.enable({ actorUserId: ADMIN, expectedVersion: 1 }))
      .resolves.toEqual({ code: "telegram_token_missing", ok: false });
    const unreadable = setup((_key, bot) => configured(randomBytes(32), bot));
    await expect(unreadable.service.enable({ actorUserId: ADMIN, expectedVersion: 1 }))
      .resolves.toEqual({ code: "telegram_token_unreadable", ok: false });
    expect(unreadable.fake.calls()).toHaveLength(0);

    const { changed, fake, hooks, memory, service } = setup((key, bot) => configured(key, bot));
    const activation = vi.fn(async () => {});
    hooks.onActivation(activation);
    hooks.onActivation(async () => { throw new Error("one hook failed"); });
    const result = await service.enable({ actorUserId: ADMIN, expectedVersion: 1 });
    expect(result).toMatchObject({ ok: true, state: { enabled: true, tokenConfigured: true, version: 2 } });
    expect(memory.record.enabled).toBe(true);
    expect(fake.calls().map((call) => call.method)).toEqual(["deleteWebhook", "setMyCommands"]);
    expect(fake.commands()).toEqual(TELEGRAM_BOT_COMMANDS);
    expect(activation).toHaveBeenCalledWith(expect.objectContaining({ botId: fake.bot.id }));
    expect(changed).toHaveBeenCalledOnce();
  });

  it("stays off when Telegram refuses to hand the bot over", async () => {
    const { fake, memory, service } = setup((key, bot) => configured(key, bot));
    fake.failNext("deleteWebhook", { status: 401 });
    await expect(service.enable({ actorUserId: ADMIN, expectedVersion: 1 })).resolves.toEqual({ code: "telegram_token_rejected", ok: false });
    fake.failNext("setMyCommands", { drop: true });
    await expect(service.enable({ actorUserId: ADMIN, expectedVersion: 1 })).resolves.toEqual({ code: "telegram_unreachable", ok: false });
    expect(memory.record).toMatchObject({ enabled: false, version: 1 });
    expect(memory.repository.setEnabled).not.toHaveBeenCalled();
  });

  it("names the version for disable and access changes and refuses unknown or archived groups", async () => {
    const { changed, memory, service } = setup({ version: 3 });
    await expect(service.disable({ actorUserId: ADMIN, expectedVersion: 2 })).resolves.toEqual({ code: "telegram_control_stale", ok: false });
    await expect(service.disable({ actorUserId: ADMIN, expectedVersion: 3 })).resolves.toMatchObject({ ok: true, state: { enabled: false, version: 4 } });
    await expect(service.setAccess({ actorUserId: ADMIN, expectedVersion: 4, groupIds: [ARCHIVED_GROUP], restricted: true }))
      .resolves.toEqual({ code: "telegram_access_groups_invalid", ok: false });
    await expect(service.setAccess({ actorUserId: ADMIN, expectedVersion: 4, groupIds: [GROUP], restricted: true }))
      .resolves.toMatchObject({ ok: true, state: { groupIds: [GROUP], restricted: true, version: 5 } });
    expect(memory.record).toMatchObject({ groupIds: [GROUP], restricted: true });
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
