import { logEvent } from "../observability";
import { DISCORD_CONNECT_ADDRESS_INVALID_CODE, DISCORD_GATEWAY_CODES } from "./codes";
import type { DiscordControlRepository } from "./control/repository";
import { isDiscordBotActive, type DiscordEffectiveControl } from "./control/state";
import {
  createDiscordGatewayClient, type DiscordDispatch, type DiscordGatewayClient, type DiscordGatewayOptions,
  type DiscordGatewayState, type DiscordIdentifyPermit
} from "./gatewayClient";
import type { DiscordIntakeDispatch } from "./intake";
import type { DiscordGatewayBot, DiscordRestOutcome } from "./rest";
import type { DiscordNetwork, DiscordWebSocketFactory } from "./transport";

/**
 * The gateway session's lifecycle (PRD D-01, D-02, D-30). One session per
 * process while the bot is on with a readable token; a new token replaces it,
 * Disable closes it within seconds (resumable close, so a later Enable can
 * RESUME). The session (`session_id`, `seq`, `resume_gateway_url`) is stored
 * on the control row, its sequence at most every 5 s and on every close, so a
 * restart or an upgrade RESUMEs instead of IDENTIFYing.
 *
 * IDENTIFY is a hard budget: Discord allows 1000 a day for the whole
 * application, shared with another service on the same bot, and resets the
 * token past it. Before every IDENTIFY the session asks `GET /gateway/bot` and
 * identifies only while `session_start_limit.remaining` is at least 200, and
 * only within AIQSA's own ceiling of 30 in any 24 hours (counted on the control
 * row across processes); otherwise it waits with `discord_session_limit`.
 * Health (connected, last event, failure code) is written without bumping the
 * control version.
 */

export const DISCORD_IDENTIFY_REMAINING_FLOOR = 200;
export const DISCORD_IDENTIFY_DAILY_LIMIT = 30;
export const DISCORD_IDENTIFY_WINDOW_MS = 24 * 3_600_000;
export const DISCORD_SESSION_PROGRESS_INTERVAL_MS = 5_000;
export const DISCORD_SESSION_REEVALUATE_INTERVAL_MS = 60_000;
/** Waits after a failed `GET /gateway/bot`: 5 s doubling to 5 minutes. */
export const DISCORD_PERMIT_RETRY_MIN_MS = 5_000;
export const DISCORD_PERMIT_RETRY_MAX_MS = 5 * 60_000;
/** A Discord-side budget reset is waited for within these bounds. */
const SESSION_LIMIT_WAIT_MIN_MS = 60_000;
const SESSION_LIMIT_WAIT_MAX_MS = 24 * 3_600_000;

export type DiscordSessionStore = Pick<DiscordControlRepository, "recordHealth" | "saveSession" | "saveProgress" | "reserveIdentify">;

export type DiscordSessionStatus = Readonly<{
  state: DiscordGatewayState["status"] | "off";
  code?: string;
  generation: number | null;
}>;

export type DiscordSession = Readonly<{
  /** Starts, stops or replaces the gateway client after a control change; calls are serialized. */
  reevaluate(): Promise<void>;
  /** Stops this process's session and saves its progress; the session stays resumable. */
  stop(): Promise<void>;
  status(): DiscordSessionStatus;
  connected(): boolean;
}>;

export type DiscordSessionDeps = Readonly<{
  control(): Promise<DiscordEffectiveControl>;
  store: DiscordSessionStore;
  /** `GET /gateway/bot` with this token. */
  gatewayBot(token: string): Promise<DiscordRestOutcome<DiscordGatewayBot>>;
  /** The network settings; throws when `AIQSA_DISCORD_CONNECT_ADDRESS` is invalid. */
  network(): DiscordNetwork;
  openSocket?: DiscordWebSocketFactory;
  /** Every dispatch, with the session it came from (intake dedupes on it). */
  onDispatch(dispatch: DiscordIntakeDispatch): void | Promise<void>;
  /** After READY of a new session (`identified`, which may have missed events) or RESUMED. */
  onReady?(kind: "identified" | "resumed"): void;
  createClient?: (options: DiscordGatewayOptions) => DiscordGatewayClient;
  now?: () => number;
  random?: () => number;
  progressIntervalMs?: number;
}>;

type Running = {
  client: DiscordGatewayClient;
  generation: number;
  /** The control version the client started under; a stopped client restarts only after a change. */
  version: number;
  lastEventAt: number | null;
  dirty: boolean;
  healthCode: string | null;
};

function log(fields: Readonly<{ stage: "identify" | "close"; outcome: "blocked" | "waiting" | "failed"; code: string; delay_ms?: number; attempt?: number }>): void {
  logEvent("discord_gateway", fields);
}

export function createDiscordSession(deps: DiscordSessionDeps): DiscordSession {
  const now = deps.now ?? Date.now;
  const createClient = deps.createClient ?? createDiscordGatewayClient;
  const progressIntervalMs = deps.progressIntervalMs ?? DISCORD_SESSION_PROGRESS_INTERVAL_MS;
  let running: Running | null = null;
  let chain: Promise<void> = Promise.resolve();
  let permitFailures = 0;
  let addressInvalidRecorded = false;
  let progressTimer: ReturnType<typeof setInterval> | null = null;

  async function quietly(work: () => Promise<void>, code: string): Promise<void> {
    try {
      await work();
    } catch (error) {
      logEvent("service_operation", { code, error, outcome: "failed", stage: "write", subsystem: "discord" });
    }
  }

  async function flush(target: Running): Promise<void> {
    const session = target.client.session();
    const lastEventAt = target.lastEventAt;
    if (!target.dirty || !session || lastEventAt === null) return;
    target.dirty = false;
    await quietly(() => deps.store.saveProgress({
      generation: target.generation, lastEventAt: new Date(lastEventAt), seq: session.seq, sessionId: session.sessionId
    }), "discord_session_write_failed");
  }

  function health(target: Running, code: string | null, options: { keepEarlier?: boolean } = {}): void {
    if (target.healthCode === code && code !== null) return;
    target.healthCode = code;
    const at = new Date(now());
    void quietly(() => deps.store.recordHealth(code === null
      ? { connectedAt: at, failure: null, generation: target.generation }
      : { failure: { at, code, ...(options.keepEarlier ? { keepEarlier: true } : {}) }, generation: target.generation }), "discord_health_write_failed");
  }

  function permitDelay(): number {
    const delay = Math.min(DISCORD_PERMIT_RETRY_MAX_MS, DISCORD_PERMIT_RETRY_MIN_MS * 2 ** Math.min(permitFailures, 8));
    permitFailures += 1;
    return delay;
  }

  async function permit(target: () => Running | null, token: string): Promise<DiscordIdentifyPermit> {
    const answer = await deps.gatewayBot(token);
    const current = target();
    if (!answer.ok) {
      if (answer.status === 401 && current) {
        health(current, DISCORD_GATEWAY_CODES.tokenRejected);
        log({ code: DISCORD_GATEWAY_CODES.tokenRejected, outcome: "blocked", stage: "identify" });
        current.client.stop();
        return { code: DISCORD_GATEWAY_CODES.tokenRejected, ok: false, retryAfterMs: SESSION_LIMIT_WAIT_MAX_MS };
      }
      return { code: DISCORD_GATEWAY_CODES.disconnected, ok: false, retryAfterMs: permitDelay() };
    }
    permitFailures = 0;
    const limit = answer.value.session_start_limit;
    if (limit.remaining < DISCORD_IDENTIFY_REMAINING_FLOOR) {
      const delay = Math.min(SESSION_LIMIT_WAIT_MAX_MS, Math.max(SESSION_LIMIT_WAIT_MIN_MS, limit.reset_after));
      if (current) health(current, DISCORD_GATEWAY_CODES.identifyRefused);
      log({ code: DISCORD_GATEWAY_CODES.identifyRefused, delay_ms: delay, outcome: "blocked", stage: "identify" });
      return { code: DISCORD_GATEWAY_CODES.identifyRefused, ok: false, retryAfterMs: delay };
    }
    const reservation = await deps.store.reserveIdentify({
      limit: DISCORD_IDENTIFY_DAILY_LIMIT, now: new Date(now()), windowMs: DISCORD_IDENTIFY_WINDOW_MS
    });
    if (!reservation.ok) {
      const delay = Math.min(SESSION_LIMIT_WAIT_MAX_MS, Math.max(SESSION_LIMIT_WAIT_MIN_MS, reservation.retryAt.getTime() - now()));
      if (current) health(current, DISCORD_GATEWAY_CODES.identifyRefused);
      log({ attempt: reservation.count, code: DISCORD_GATEWAY_CODES.identifyRefused, delay_ms: delay, outcome: "blocked", stage: "identify" });
      return { code: DISCORD_GATEWAY_CODES.identifyRefused, ok: false, retryAfterMs: delay };
    }
    return { ok: true, url: answer.value.url };
  }

  function onState(target: Running, state: DiscordGatewayState): void {
    if (running !== target) return;
    if (state.status === "ready") {
      health(target, null);
      return;
    }
    if (state.status === "waiting" && state.code === DISCORD_GATEWAY_CODES.disconnected) {
      void flush(target);
      // An outage keeps the time it began; the attention rule measures from there.
      if (target.healthCode === null) health(target, DISCORD_GATEWAY_CODES.disconnected, { keepEarlier: true });
      return;
    }
    if (state.status === "stopped" && state.code) {
      void flush(target);
      health(target, state.code);
    }
  }

  function onDispatch(target: Running, dispatch: DiscordDispatch): void {
    if (running !== target) return;
    target.lastEventAt = now();
    target.dirty = true;
    const sessionId = target.client.session()?.sessionId ?? null;
    if (dispatch.type === "READY") deps.onReady?.("identified");
    else if (dispatch.type === "RESUMED") deps.onReady?.("resumed");
    void Promise.resolve(deps.onDispatch({ data: dispatch.data, seq: dispatch.seq, sessionId, type: dispatch.type }))
      .catch((error: unknown) => {
        logEvent("service_operation", { code: "discord_intake_failed", error, outcome: "failed", stage: "dispatch", subsystem: "discord" });
      });
  }

  function ensureProgressTimer(): void {
    if (progressTimer) return;
    progressTimer = setInterval(() => {
      if (running) void flush(running);
    }, progressIntervalMs);
    progressTimer.unref?.();
  }

  async function shutdown(target: Running): Promise<void> {
    target.client.stop();
    await flush(target);
  }

  async function evaluate(): Promise<void> {
    const control = await deps.control();
    if (!isDiscordBotActive(control)) {
      if (running) {
        const target = running;
        running = null;
        await shutdown(target);
      }
      return;
    }
    if (running && running.generation !== control.bot.generation) {
      const target = running;
      running = null;
      await shutdown(target);
    }
    if (running) {
      if (running.client.state().status !== "stopped" || running.version === control.version) return;
      // Something changed since Discord stopped the session (a fix in the Developer Portal, then any save): try again.
      const target = running;
      running = null;
      await shutdown(target);
    }
    let network: DiscordNetwork;
    try {
      network = deps.network();
    } catch {
      if (!addressInvalidRecorded) {
        addressInvalidRecorded = true;
        logEvent("service_operation", { action: "degrade", code: DISCORD_CONNECT_ADDRESS_INVALID_CODE, outcome: "failed", stage: "startup", subsystem: "discord" });
        await quietly(() => deps.store.recordHealth({
          failure: { at: new Date(now()), code: DISCORD_CONNECT_ADDRESS_INVALID_CODE }, generation: control.bot.generation
        }), "discord_health_write_failed");
      }
      return;
    }
    const token = control.bot.token;
    const generation = control.bot.generation;
    let target: Running | null = null;
    const client = createClient({
      beforeIdentify: () => permit(() => target, token),
      network,
      onDispatch: (dispatch) => { if (target) onDispatch(target, dispatch); },
      onSession: (session) => {
        void quietly(() => deps.store.saveSession({ generation, session }), "discord_session_write_failed");
      },
      onState: (state) => { if (target) onState(target, state); },
      ...(deps.openSocket ? { openSocket: deps.openSocket } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      now,
      session: control.session,
      token: () => token
    });
    target = { client, dirty: false, generation, healthCode: null, lastEventAt: null, version: control.version };
    running = target;
    ensureProgressTimer();
    client.start();
  }

  function serialized(work: () => Promise<void>): Promise<void> {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  }

  return Object.freeze({
    reevaluate: () => serialized(evaluate),
    stop: () => serialized(async () => {
      if (progressTimer) clearInterval(progressTimer);
      progressTimer = null;
      if (!running) return;
      const target = running;
      running = null;
      await shutdown(target);
    }),
    status: () => {
      if (!running) return { generation: null, state: "off" as const };
      const state = running.client.state();
      return { generation: running.generation, state: state.status, ...(state.code ? { code: state.code } : {}) };
    },
    connected: () => running?.client.state().status === "ready"
  });
}
