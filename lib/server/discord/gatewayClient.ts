import { DISCORD_GATEWAY_INTENTS } from "../../contracts/discord";
import { logEvent } from "../observability";
import { DISCORD_GATEWAY_CODES } from "./codes";
import { discordGatewayUrl, openDiscordWebSocket, type DiscordNetwork, type DiscordWebSocketFactory, type DiscordWebSocketLike } from "./transport";

/**
 * One Discord gateway session, shard `[0, 1]`, JSON without compression and
 * without presence (PRD D-01). HELLO starts a jittered heartbeat; a beat
 * whose predecessor was never acknowledged is a zombie connection, closed
 * with a non-1000 code and resumed. IDENTIFY happens only when no session can
 * be resumed: `beforeIdentify` (Discord's remaining starts, owned by the
 * session lifecycle) is asked before connecting, and `reserveIdentify` (the
 * local daily budget) only once HELLO arrived, right before op 2 is sent, so a
 * connection that never reaches HELLO and every RESUME spend nothing; RESUME
 * uses the session's `resume_gateway_url`. Close codes 4004 and 4010–4014
 * stop for good with a health code. Outgoing payloads stay within 4096 bytes and 100 commands a
 * minute. The token is only ever inside IDENTIFY and RESUME payloads, which
 * are never logged.
 */

export const DISCORD_GATEWAY_PAYLOAD_MAX_BYTES = 4_096;
export const DISCORD_GATEWAY_COMMANDS_PER_MINUTE = 100;
export const DISCORD_GATEWAY_BACKOFF_MIN_MS = 1_000;
export const DISCORD_GATEWAY_BACKOFF_MAX_MS = 60_000;
/** Our own non-1000 close: Discord keeps the session for RESUME. */
export const DISCORD_GATEWAY_RECONNECT_CLOSE_CODE = 4_900;
const OPEN = 1;
const HEARTBEAT_INTERVAL_MAX_MS = 10 * 60_000;

export const DISCORD_GATEWAY_OPCODES = Object.freeze({
  dispatch: 0, heartbeat: 1, identify: 2, resume: 6, reconnect: 7, invalidSession: 9, hello: 10, heartbeatAck: 11
});

/** Close codes after which reconnecting cannot help, with the health code each means. */
export const DISCORD_GATEWAY_STOP_CODES: Readonly<Record<number, string>> = Object.freeze({
  4004: DISCORD_GATEWAY_CODES.tokenRejected,
  4010: DISCORD_GATEWAY_CODES.refused,
  4011: DISCORD_GATEWAY_CODES.refused,
  4012: DISCORD_GATEWAY_CODES.refused,
  4013: DISCORD_GATEWAY_CODES.intentsDisallowed,
  4014: DISCORD_GATEWAY_CODES.intentsDisallowed
});
/** Close codes after which the session cannot be resumed. */
const NEW_SESSION_CLOSE_CODES = new Set([1000, 1001, 4007, 4009]);

export type DiscordGatewaySession = Readonly<{ sessionId: string; seq: number | null; resumeGatewayUrl: string }>;
export type DiscordGatewayStatus = "idle" | "connecting" | "identifying" | "resuming" | "ready" | "waiting" | "stopped";
export type DiscordGatewayState = Readonly<{ status: DiscordGatewayStatus; code?: string; closeCode?: number }>;
export type DiscordDispatch = Readonly<{ type: string; seq: number; data: unknown }>;
export type DiscordIdentifyPermit =
  | Readonly<{ ok: true; url: string }>
  | Readonly<{ ok: false; code: string; retryAfterMs: number }>;
/** The local budget's answer right before op 2: send it, or close and ask again later. */
export type DiscordIdentifyGrant =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: string; retryAfterMs: number }>;
export type DiscordGatewaySendResult = Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>;

export type DiscordGatewayOptions = Readonly<{
  token: () => string | null;
  network: DiscordNetwork;
  /** Opens one connection; defaults to the pinned undici WebSocket. */
  openSocket?: DiscordWebSocketFactory;
  /** A persisted session to RESUME first. */
  session?: DiscordGatewaySession | null;
  /** Asked before connecting for an IDENTIFY: the gateway URL, or when to ask again. Spends no IDENTIFY. */
  beforeIdentify: () => Promise<DiscordIdentifyPermit>;
  /**
   * Asked after HELLO, right before op 2 is sent, and never for a RESUME; a
   * refusal closes the connection (resumable code) and waits. Without it op 2
   * is sent at once.
   */
  reserveIdentify?: () => Promise<DiscordIdentifyGrant>;
  onDispatch?: (dispatch: DiscordDispatch) => void;
  /**
   * READY's new session, or `null` when the session became unusable; then
   * `forgotten` is the session given up, so a store clears only that one.
   */
  onSession?: (session: DiscordGatewaySession | null, forgotten?: DiscordGatewaySession) => void;
  onState?: (state: DiscordGatewayState) => void;
  intents?: number;
  random?: () => number;
  now?: () => number;
}>;

export type DiscordGatewayClient = Readonly<{
  start(): void;
  /** Closes with a resumable code and keeps the session, so a restart resumes. */
  stop(): void;
  /** Sends one guarded command; IDENTIFY, RESUME and heartbeats go through it too. */
  send(op: number, data: unknown): DiscordGatewaySendResult;
  state(): DiscordGatewayState;
  session(): DiscordGatewaySession | null;
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function decode(data: unknown): Record<string, unknown> | undefined {
  try {
    if (typeof data === "string") return record(JSON.parse(data));
    if (data instanceof ArrayBuffer) return record(JSON.parse(Buffer.from(data).toString("utf8")));
    if (ArrayBuffer.isView(data)) return record(JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")));
  } catch {
    return undefined;
  }
  return undefined;
}

export function createDiscordGatewayClient(options: DiscordGatewayOptions): DiscordGatewayClient {
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const openSocket = options.openSocket ?? ((url: URL) => openDiscordWebSocket(url, options.network));
  const intents = options.intents ?? DISCORD_GATEWAY_INTENTS;
  let session: { sessionId: string; seq: number | null; resumeGatewayUrl: string } | null = options.session
    ? { ...options.session } : null;
  let state: DiscordGatewayState = { status: "idle" };
  let socket: DiscordWebSocketLike | null = null;
  let generation = 0;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatInterval = 0;
  let acknowledged = true;
  let failures = 0;
  let commandTimes: number[] = [];
  let connectedAt = 0;

  function setState(next: DiscordGatewayState): void {
    state = next;
    options.onState?.(next);
  }

  function clearTimers(): void {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    heartbeatTimer = null;
    reconnectTimer = null;
  }

  function dropSocket(code: number): void {
    const current = socket;
    socket = null;
    generation += 1;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    if (current && current.readyState <= OPEN) {
      try { current.close(code); } catch { /* already closing */ }
    }
  }

  function send(op: number, data: unknown): DiscordGatewaySendResult {
    if (!socket || socket.readyState !== OPEN) return { ok: false, code: DISCORD_GATEWAY_CODES.notOpen };
    const payload = JSON.stringify({ op, d: data });
    if (Buffer.byteLength(payload, "utf8") > DISCORD_GATEWAY_PAYLOAD_MAX_BYTES) return { ok: false, code: DISCORD_GATEWAY_CODES.payloadTooLarge };
    const current = now();
    commandTimes = commandTimes.filter((time) => time > current - 60_000);
    // Heartbeats always go: Discord's own limit (120 a minute) leaves them room above ours.
    if (op !== DISCORD_GATEWAY_OPCODES.heartbeat && commandTimes.length >= DISCORD_GATEWAY_COMMANDS_PER_MINUTE) {
      return { ok: false, code: DISCORD_GATEWAY_CODES.rateLimited };
    }
    commandTimes.push(current);
    try { socket.send(payload); } catch { return { ok: false, code: DISCORD_GATEWAY_CODES.notOpen }; }
    return { ok: true };
  }

  function backoff(): number {
    const base = Math.min(DISCORD_GATEWAY_BACKOFF_MAX_MS, DISCORD_GATEWAY_BACKOFF_MIN_MS * 2 ** Math.min(failures, 6));
    failures += 1;
    return Math.round(base * (0.5 + random() / 2));
  }

  function forgetSession(): void {
    if (!session) return;
    const forgotten = { ...session };
    session = null;
    options.onSession?.(null, forgotten);
  }

  function schedule(delayMs: number, code?: string): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    setState({ status: "waiting", ...(code ? { code } : {}) });
    logEvent("discord_gateway", { stage: "reconnect", outcome: "waiting", delay_ms: delayMs, ...(code ? { code } : {}), attempt: failures });
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delayMs);
  }

  function stopFor(code: string, closeCode?: number): void {
    clearTimers();
    dropSocket(DISCORD_GATEWAY_RECONNECT_CLOSE_CODE);
    if (code === DISCORD_GATEWAY_CODES.tokenRejected) forgetSession();
    setState({ status: "stopped", code, ...(closeCode ? { closeCode } : {}) });
    logEvent("discord_gateway", { stage: "close", outcome: "blocked", code, ...(closeCode ? { close_code: closeCode } : {}) });
  }

  function beat(): void {
    if (!acknowledged) {
      // No ACK since the last beat: the connection is dead even if TCP says otherwise.
      logEvent("discord_gateway", { stage: "heartbeat", outcome: "failed", code: DISCORD_GATEWAY_CODES.zombie });
      dropSocket(DISCORD_GATEWAY_RECONNECT_CLOSE_CODE);
      schedule(0);
      return;
    }
    acknowledged = false;
    send(DISCORD_GATEWAY_OPCODES.heartbeat, session?.seq ?? null);
    heartbeatTimer = setTimeout(beat, heartbeatInterval);
  }

  function identifyOrResume(): void {
    const token = options.token();
    if (!token) return stopFor(DISCORD_GATEWAY_CODES.tokenRejected);
    if (session) {
      setState({ status: "resuming" });
      send(DISCORD_GATEWAY_OPCODES.resume, { token, session_id: session.sessionId, seq: session.seq });
      logEvent("discord_gateway", { stage: "resume", outcome: "started" });
    } else {
      setState({ status: "identifying" });
      if (!options.reserveIdentify) return identify(token);
      const mine = generation;
      options.reserveIdentify().then((answer) => {
        // The connection closed or was replaced while the budget was asked: nothing goes out on it.
        if (mine !== generation || !socket || state.status === "stopped") return;
        if (!answer.ok) {
          dropSocket(DISCORD_GATEWAY_RECONNECT_CLOSE_CODE);
          schedule(Math.max(DISCORD_GATEWAY_BACKOFF_MIN_MS, answer.retryAfterMs), answer.code);
          return;
        }
        identify(token);
      }, () => {
        if (mine !== generation || state.status === "stopped") return;
        dropSocket(DISCORD_GATEWAY_RECONNECT_CLOSE_CODE);
        schedule(backoff(), DISCORD_GATEWAY_CODES.disconnected);
      });
    }
  }

  function identify(token: string): void {
    send(DISCORD_GATEWAY_OPCODES.identify, {
      token, intents, shard: [0, 1], properties: { os: "linux", browser: "aiqsa", device: "aiqsa" }
    });
    logEvent("discord_gateway", { stage: "identify", outcome: "started" });
  }

  function onMessage(payload: Record<string, unknown>): void {
    const op = payload.op;
    if (typeof payload.s === "number" && Number.isSafeInteger(payload.s) && session) session.seq = payload.s;
    if (op === DISCORD_GATEWAY_OPCODES.hello) {
      const interval = record(payload.d)?.heartbeat_interval;
      if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 1 || interval > HEARTBEAT_INTERVAL_MAX_MS) {
        dropSocket(DISCORD_GATEWAY_RECONNECT_CLOSE_CODE);
        schedule(backoff(), DISCORD_GATEWAY_CODES.disconnected);
        return;
      }
      heartbeatInterval = interval;
      acknowledged = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(beat, Math.floor(interval * random()));
      identifyOrResume();
      return;
    }
    if (op === DISCORD_GATEWAY_OPCODES.heartbeatAck) { acknowledged = true; return; }
    if (op === DISCORD_GATEWAY_OPCODES.heartbeat) { send(DISCORD_GATEWAY_OPCODES.heartbeat, session?.seq ?? null); return; }
    if (op === DISCORD_GATEWAY_OPCODES.reconnect) {
      logEvent("discord_gateway", { stage: "reconnect", outcome: "started", resumable: session !== null });
      dropSocket(DISCORD_GATEWAY_RECONNECT_CLOSE_CODE);
      schedule(0);
      return;
    }
    if (op === DISCORD_GATEWAY_OPCODES.invalidSession) {
      const resumable = payload.d === true;
      logEvent("discord_gateway", { stage: "invalid_session", outcome: "failed", resumable });
      if (!resumable) forgetSession();
      dropSocket(DISCORD_GATEWAY_RECONNECT_CLOSE_CODE);
      // Discord asks for a random 1–5 s wait before the next IDENTIFY or RESUME.
      schedule(1_000 + Math.floor(random() * 4_000));
      return;
    }
    if (op !== DISCORD_GATEWAY_OPCODES.dispatch || typeof payload.t !== "string" || typeof payload.s !== "number") return;
    if (payload.t === "READY") {
      const data = record(payload.d);
      const sessionId = data?.session_id;
      const resumeUrl = typeof data?.resume_gateway_url === "string" ? discordGatewayUrl(data.resume_gateway_url, options.network) : null;
      if (typeof sessionId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(sessionId) && resumeUrl) {
        session = { sessionId, seq: payload.s, resumeGatewayUrl: resumeUrl.href };
        options.onSession?.({ ...session });
      }
      ready("ready");
    } else if (payload.t === "RESUMED") {
      ready("resumed");
    }
    options.onDispatch?.({ type: payload.t, seq: payload.s, data: payload.d });
  }

  function ready(stage: "ready" | "resumed"): void {
    failures = 0;
    setState({ status: "ready" });
    logEvent("discord_gateway", { stage, outcome: "completed", duration_ms: Math.max(0, now() - connectedAt) });
  }

  function onClose(code: number): void {
    socket = null;
    generation += 1;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    const stop = DISCORD_GATEWAY_STOP_CODES[code];
    if (stop) return stopFor(stop, code);
    logEvent("discord_gateway", { stage: "close", outcome: "failed", close_code: code >= 1000 && code <= 4999 ? code : undefined });
    if (NEW_SESSION_CLOSE_CODES.has(code)) forgetSession();
    schedule(backoff(), DISCORD_GATEWAY_CODES.disconnected);
  }

  function open(url: URL): void {
    const mine = ++generation;
    connectedAt = now();
    setState({ status: "connecting" });
    let opened: DiscordWebSocketLike;
    try { opened = openSocket(url); } catch {
      schedule(backoff(), DISCORD_GATEWAY_CODES.disconnected);
      return;
    }
    socket = opened;
    logEvent("discord_gateway", { stage: "connect", outcome: "started" });
    opened.addEventListener("message", (event) => {
      if (mine !== generation) return;
      const payload = decode(event.data);
      if (payload) onMessage(payload);
    });
    opened.addEventListener("close", (event) => { if (mine === generation) onClose(event.code); });
    opened.addEventListener("error", () => { /* the close event follows and decides */ });
  }

  function connect(): void {
    if (state.status === "stopped") return;
    if (session) {
      const url = discordGatewayUrl(session.resumeGatewayUrl, options.network);
      if (url) return open(url);
      forgetSession();
    }
    setState({ status: "waiting" });
    const mine = generation;
    options.beforeIdentify().then((permit) => {
      if (mine !== generation || state.status === "stopped") return;
      if (!permit.ok) return schedule(Math.max(DISCORD_GATEWAY_BACKOFF_MIN_MS, permit.retryAfterMs), permit.code);
      const url = discordGatewayUrl(options.network.gatewayUrl?.href ?? permit.url, options.network);
      if (!url) return stopFor(DISCORD_GATEWAY_CODES.urlInvalid);
      open(url);
    }, () => {
      if (mine === generation && state.status !== "stopped") schedule(backoff(), DISCORD_GATEWAY_CODES.disconnected);
    });
  }

  return Object.freeze({
    start: () => {
      if (state.status !== "idle" && state.status !== "stopped") return;
      setState({ status: "connecting" });
      failures = 0;
      connect();
    },
    stop: () => {
      clearTimers();
      dropSocket(DISCORD_GATEWAY_RECONNECT_CLOSE_CODE);
      setState({ status: "stopped" });
    },
    send,
    state: () => state,
    session: () => session ? { ...session } : null
  });
}
