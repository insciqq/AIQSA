import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeTelegramBotApi, FAKE_TELEGRAM_TOKEN, type FakeTelegramBotApi } from "@/tests/support/fakeTelegramBotApi";
import { captureRunObservation } from "@/tests/support/runObservation";
import failureCodes from "../observability/failureCodes.json";
import { createTelegramBotApi, createTelegramPacer, type TelegramBotApi, type TelegramUpdate } from "./botApi";
import type { TelegramControlRepository } from "./control/repository";
import { createTelegramSessionProvider, type TelegramSessionProvider } from "./control/session";
import type { TelegramEffectiveControl } from "./control/state";
import type { TelegramBotSession } from "./dispatcher";
import type { TelegramOutbound } from "./outbound";
import { createTelegramPoller, TELEGRAM_POLL_TIMEOUT_SECONDS, telegramPollFailureCode, type TelegramPoller } from "./poller";
import type { TelegramReceiptStore } from "./store/receipts";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => { while (stops.length) await stops.pop()!(); });

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Claims shared by every poller of a test (one database); each poller may keep its own offset view. */
function memoryClaims() {
  return new Set<string>();
}

function memoryReceipts(claims = memoryClaims(), options: Readonly<{ failClaims?: number }> = {}) {
  let offset: { botId: number; value: number } | null = null;
  let failures = options.failClaims ?? 0;
  const store: Pick<TelegramReceiptStore, "claimBatch" | "readOffset"> = {
    readOffset: vi.fn(async (botId: number) => offset && offset.botId === botId ? offset.value : null),
    claimBatch: vi.fn(async ({ botId, nextOffset, updates }) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("database unavailable");
      }
      const claimed = new Set<number>();
      for (const update of updates) {
        const key = `${botId}:${update.updateId}`;
        if (claims.has(key)) continue;
        claims.add(key);
        claimed.add(update.updateId);
      }
      if (!offset || offset.botId !== botId || offset.value < nextOffset) offset = { botId, value: nextOffset };
      return claimed;
    })
  };
  return { get offset() { return offset?.value ?? null; }, store };
}

function control(fake: FakeTelegramBotApi, overrides: Partial<TelegramEffectiveControl> = {}): TelegramEffectiveControl {
  return {
    bot: { generation: 1, id: fake.bot.id, token: fake.token, username: fake.bot.username },
    enabled: true, groupIds: new Set(), restricted: false, tokenState: "ready", version: 1, ...overrides
  };
}

function setup(options: Readonly<{ failClaims?: number; sessions?: TelegramSessionProvider }> = {}) {
  const fake = createFakeTelegramBotApi();
  let current = control(fake);
  const sessions = options.sessions ?? createTelegramSessionProvider({
    control: async () => current,
    createApi: (token) => createTelegramBotApi({ pacer: createTelegramPacer({ now: () => 0 }), sleep: async () => {}, token, transport: fake.transport }),
    createOutbound: () => ({}) as TelegramOutbound
  });
  const receipts = memoryReceipts(memoryClaims(), { failClaims: options.failClaims });
  const dispatched: TelegramUpdate[] = [];
  const health: Array<{ code: string | null; success: boolean }> = [];
  const recordPollHealth = vi.fn<TelegramControlRepository["recordPollHealth"]>(async (input) => {
    health.push({ code: input.failureCode, success: input.success });
  });
  const delays: number[] = [];
  const poller = createTelegramPoller({
    dispatcher: { dispatch: (update) => { dispatched.push(update); return { settled: Promise.resolve() }; } },
    health: { recordPollHealth }, receipts: receipts.store, sessions, sleep: async (ms) => { delays.push(ms); }
  });
  stops.push(async () => {
    const stopping = poller.stop();
    await fake.close();
    await stopping;
  });
  return {
    delays, dispatched, fake, health, poller, receipts, recordPollHealth,
    setControl: (next: TelegramEffectiveControl) => { current = next; }
  };
}

describe("Telegram poller", () => {
  it("long-polls with the allowed updates, claims a batch before moving the offset past it and dispatches each claimed update", async () => {
    const { dispatched, fake, health, poller, receipts } = setup();
    const user = fake.inject.addUser();
    const first = fake.inject.text(user, "one");
    const second = fake.inject.text(user, "two");
    poller.reevaluate();
    await until(() => dispatched.length === 2);
    expect(dispatched.map((update) => update.update_id)).toEqual([first.update_id, second.update_id]);
    expect(receipts.offset).toBe(second.update_id + 1);
    // The next poll confirms the batch by its offset; a new update ends that poll.
    const third = fake.inject.text(user, "three");
    await until(() => dispatched.length === 3 && fake.pendingUpdates() === 0);
    const [initial, next] = fake.calls("getUpdates");
    expect(initial!.params).toEqual({
      allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member", "stopped_message_generation"],
      limit: 100, timeout: TELEGRAM_POLL_TIMEOUT_SECONDS
    });
    expect(next!.params).toMatchObject({ offset: second.update_id + 1 });
    expect(receipts.offset).toBe(third.update_id + 1);
    expect(receipts.store.claimBatch).toHaveBeenCalledTimes(2);
    expect(dispatched.map((update) => update.update_id)).toEqual([first.update_id, second.update_id, third.update_id]);
    expect(health[0]).toEqual({ code: null, success: true });
    expect(poller.state()).toBe("polling");
  });

  it("neither confirms nor loses a batch whose claim failed", async () => {
    const { delays, dispatched, fake, poller, receipts } = setup({ failClaims: 1 });
    const user = fake.inject.addUser();
    const update = fake.inject.text(user, "kept");
    poller.reevaluate();
    await until(() => dispatched.length === 1);
    expect(delays).toEqual([1_000]);
    expect(receipts.store.claimBatch).toHaveBeenCalledTimes(2);
    expect(fake.calls("getUpdates")[1]!.params).not.toHaveProperty("offset");
    expect(dispatched.map((entry) => entry.update_id)).toEqual([update.update_id]);
  });

  it("backs off from 1 s to 60 s on a conflict, reports its health code and recovers", async () => {
    const capture = await captureRunObservation();
    const { delays, dispatched, fake, health, poller } = setup();
    fake.failNext("getUpdates", { status: 409 }, 8);
    const user = fake.inject.addUser();
    fake.inject.text(user, "after the conflict");
    poller.reevaluate();
    await until(() => dispatched.length === 1);
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(health.slice(0, 8)).toEqual(Array.from({ length: 8 }, () => ({ code: "telegram_poll_conflict", success: false })));
    expect(health[8]).toEqual({ code: null, success: true });
    const records = capture.records();
    expect(records).toContainEqual(expect.objectContaining({ code: "telegram_poll_conflict", event: "runtime_lifecycle", subsystem: "telegram" }));
    expect(records).toContainEqual(expect.objectContaining({ event: "subsystem.recovered", subsystem: "telegram" }));
    expect(JSON.stringify(records)).not.toContain(FAKE_TELEGRAM_TOKEN.split(":")[1]!);
  });

  it("stops on a rejected token until an administrator's change, and reports Telegram as unreachable on network failures", async () => {
    const { delays, fake, health, poller } = setup();
    fake.failNext("getUpdates", { status: 401 });
    poller.reevaluate();
    await until(() => poller.state() === "token_rejected");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.calls("getUpdates")).toHaveLength(1);
    expect(health).toEqual([{ code: "telegram_token_rejected", success: false }]);
    expect(delays).toEqual([]);

    fake.failNext("getUpdates", { drop: true });
    fake.inject.text(fake.inject.addUser(), "after the outage");
    poller.reevaluate();
    await until(() => health.length >= 3);
    expect(health[1]).toEqual({ code: "telegram_unreachable", success: false });
    expect(delays).toEqual([1_000]);
    expect(health[2]).toEqual({ code: null, success: true });
  });

  it("goes idle when the bot is switched off and drops a batch polled across the change", async () => {
    const { dispatched, fake, poller, receipts, setControl } = setup();
    const user = fake.inject.addUser();
    fake.inject.text(user, "polled while switching off");
    fake.failNext("getUpdates", { delayMs: 30 });
    poller.reevaluate();
    await until(() => fake.calls("getUpdates").length === 1 || poller.state() === "polling");
    setControl(control(fake, { enabled: false }));
    await until(() => poller.state() === "idle");
    expect(receipts.store.claimBatch).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
    expect(fake.pendingUpdates()).toBe(1);
  });

  it("handles an update once when two pollers sharing one database both receive it", async () => {
    const claims = memoryClaims();
    const update: TelegramUpdate = { kind: "other", update_id: 4_242 };
    const dispatched: number[] = [];
    const pollers: TelegramPoller[] = [];
    const releases: Array<() => void> = [];
    for (let index = 0; index < 2; index += 1) {
      let served = false;
      const api = {
        getUpdates: async () => {
          if (!served) {
            served = true;
            return { ok: true, result: [update] };
          }
          await new Promise<void>((resolve) => { releases.push(resolve); });
          return { ok: true, result: [] };
        }
      } as unknown as TelegramBotApi;
      const session = { api, botId: 100000001, botUsername: "aiqsa_test_bot", generation: 1, outbound: {} } as TelegramBotSession;
      const poller = createTelegramPoller({
        dispatcher: { dispatch: (entry) => { dispatched.push(entry.update_id); return { settled: Promise.resolve() }; } },
        health: { recordPollHealth: async () => {} }, receipts: memoryReceipts(claims).store,
        sessions: { current: async () => session }, sleep: async () => {}
      });
      pollers.push(poller);
    }
    for (const poller of pollers) poller.reevaluate();
    await until(() => releases.length === 2);
    expect(dispatched).toEqual([4_242]);
    for (const poller of pollers) {
      stops.push(async () => {
        const stopping = poller.stop();
        for (const release of releases.splice(0)) release();
        await stopping;
      });
    }
  });
});

describe("Telegram poll failures", () => {
  it("map to the three health codes", () => {
    expect(telegramPollFailureCode({ errorCode: 409, kind: "telegram", ok: false })).toBe("telegram_poll_conflict");
    expect(telegramPollFailureCode({ errorCode: 401, kind: "telegram", ok: false })).toBe("telegram_token_rejected");
    expect(telegramPollFailureCode({ errorCode: 404, kind: "telegram", ok: false })).toBe("telegram_token_rejected");
    expect(telegramPollFailureCode({ errorCode: 502, kind: "telegram", ok: false })).toBe("telegram_unreachable");
    expect(telegramPollFailureCode({ kind: "timeout", ok: false })).toBe("telegram_unreachable");
  });

  it("register every core log code in order among its sorted neighbours", () => {
    const registry = failureCodes as string[];
    for (const code of [
      "telegram_activation_hook_failed", "telegram_button_refused", "telegram_control_action_failed", "telegram_control_unavailable",
      "telegram_encryption_unavailable", "telegram_group_left", "telegram_health_write_failed", "telegram_link_action_failed",
      "telegram_link_code_rate_limited", "telegram_message_ref_failed", "telegram_notice_failed", "telegram_poll_failed", "telegram_receipt_failed",
      "telegram_record_prune_failed", "telegram_startup_failed", "telegram_token_unreadable", "telegram_update_claim_failed",
      "telegram_update_failed"
    ]) {
      const index = registry.indexOf(code);
      expect(index, code).toBeGreaterThan(0);
      expect(registry[index - 1]! < code && code < registry[index + 1]!, code).toBe(true);
    }
  });
});
