import {
  CONNECT_HEARTBEAT_SECONDS,
  CONNECT_MAX_INPUT_BYTES,
  CONNECT_SESSION_ID_PATTERN,
  connectPairingDecisionRequestSchema,
  connectSessionCreateRequestSchema,
  connectUtf8ByteLength,
  connectViewCreateRequestSchema,
  connectViewInputRequestSchema,
  connectViewResizeRequestSchema,
  connectViewVisibilityRequestSchema,
  type ConnectCommandResult,
  type ConnectPairingDecisionResponse,
  type ConnectRequestCommandType
} from "@/lib/contracts/connect";
import type { LoginRateLimiter } from "../auth/rateLimit";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  CONNECT_BROWSER_HEADERS,
  CONNECT_INPUT_BODY_BYTES,
  CONNECT_SMALL_BODY_BYTES,
  connectRateLimited,
  connectRefusal,
  connectUnavailable,
  isConnectId,
  readConnectJson
} from "./http";
import { logConnect } from "./observability";
import type { ConnectPairingService } from "./pairingService";
import type { ConnectPolicyGate } from "./policy";
import type { ConnectRelay, ConnectRequestCommand, ConnectViewOwner } from "./relay";
import type { ConnectRepository } from "./repository";
import {
  CONNECT_EVENTS_STREAM_QUEUE_BYTES,
  CONNECT_VIEW_STREAM_QUEUE_BYTES,
  createConnectSseStream,
  type ConnectSseStream
} from "./sse";

export type ConnectBrowserHandlerDeps = Readonly<{
  /** Per account: pairing code lookups and decisions. */
  codeRateLimiter: LoginRateLimiter;
  heartbeatMs?: number;
  now?: () => Date;
  pairing: Pick<ConnectPairingService, "decide" | "lookup">;
  policy: Pick<ConnectPolicyGate, "enabled">;
  relay: ConnectRelay;
  repository: Pick<ConnectRepository, "deleteDevice" | "deviceExists" | "isAuthSessionActive" | "listDevices">;
  resolveAuth: RequestAuthResolver;
}>;

type Params<T extends string> = Readonly<{ params: Promise<Readonly<Record<T, string>>> }>;
type Owner = ConnectViewOwner;

/**
 * The browser API under `/api/connect` for the signed-in owner of personal
 * devices. Every handler authenticates, checks the installation switch and
 * the owner at the operation; another account's device, session or view
 * answers exactly like a missing one, administrators included. Responses are
 * private and never cached; mutations get the proxy's same-origin check.
 */
export function createConnectBrowserHandlers(deps: ConnectBrowserHandlerDeps) {
  const clock = deps.now ?? (() => new Date());
  const heartbeatMs = deps.heartbeatMs ?? CONNECT_HEARTBEAT_SECONDS * 1000;
  const headers = CONNECT_BROWSER_HEADERS;
  const refuse = (code: Parameters<typeof connectRefusal>[0]) => connectRefusal(code, headers);
  const notFound = () => refuse("connect_not_found");
  const json = (body: unknown, status = 200) => Response.json(body, { headers, status });
  const noContent = () => new Response(null, { headers, status: 204 });

  function unavailable(error: unknown, stage: "delete" | "read" | "write"): Response {
    logConnect({ action: "retry", code: "connect_store_unavailable", error, outcome: "failed", stage });
    return connectUnavailable(headers);
  }

  async function authorize(request: Request): Promise<Owner | Response> {
    let auth: Awaited<ReturnType<RequestAuthResolver>>;
    try {
      auth = await deps.resolveAuth(request);
    } catch (error) {
      return unavailable(error, "read");
    }
    if (!auth || auth.user.status !== "active") return refuse("connect_unauthorized");
    try {
      if (!(await deps.policy.enabled())) return refuse("connect_disabled");
    } catch (error) {
      logConnect({ action: "retry", code: "connect_policy_unavailable", error, outcome: "failed", stage: "read" });
      return connectUnavailable(headers);
    }
    return { authSessionId: auth.id, userId: auth.userId };
  }

  /** The relay answers offline for any device without a stream; the store tells offline from missing. */
  async function offlineOrMissing(owner: Owner, deviceId: string): Promise<Response> {
    try {
      return refuse((await deps.repository.deviceExists({ id: deviceId, userId: owner.userId }))
        ? "connect_device_offline"
        : "connect_not_found");
    } catch (error) {
      return unavailable(error, "read");
    }
  }

  async function deviceRequest<T extends ConnectRequestCommandType>(
    owner: Owner,
    deviceId: string,
    command: ConnectRequestCommand<T>
  ): Promise<ConnectCommandResult<T> | Response> {
    const outcome = await deps.relay.request<T>({ command, deviceId, userId: owner.userId });
    if (outcome.ok) return outcome.result;
    if (outcome.code === "connect_device_offline") return offlineOrMissing(owner, deviceId);
    return refuse(outcome.code);
  }

  async function body(request: Request, maxBytes = CONNECT_SMALL_BODY_BYTES): Promise<unknown | Response> {
    const read = await readConnectJson(request, maxBytes);
    return read.ok ? read.value : refuse(read.code);
  }

  async function codeAttempt(owner: Owner): Promise<Response | null> {
    let decision: Awaited<ReturnType<LoginRateLimiter["check"]>>;
    try {
      decision = await deps.codeRateLimiter.check(`connect:pairing-code:user:${owner.userId}`);
    } catch (error) {
      return unavailable(error, "read");
    }
    if (decision.allowed) return null;
    logConnect({ action: "wait", code: "connect_rate_limited", outcome: "blocked", stage: "preflight" });
    return connectRateLimited(headers, decision.retryAfterSeconds);
  }

  /** Re-checks a stream's browser session and the switch; transient failures keep the stream. */
  async function streamAuthority(owner: Owner): Promise<"connect_disabled" | "connect_unauthorized" | null> {
    try {
      if (!(await deps.repository.isAuthSessionActive({ now: clock(), sessionId: owner.authSessionId, userId: owner.userId }))) {
        return "connect_unauthorized";
      }
      return (await deps.policy.enabled()) ? null : "connect_disabled";
    } catch {
      return null;
    }
  }

  function viewStreamHeartbeat(owner: Owner, viewId: string, writerId: string, stream: ConnectSseStream) {
    let checking = false;
    const timer = setInterval(() => {
      if (!deps.relay.pingView(viewId, writerId)) {
        stream.close();
        return;
      }
      if (checking) return;
      checking = true;
      void streamAuthority(owner).then((refusal) => {
        if (refusal === "connect_unauthorized") deps.relay.closeViewsForAuthSession(owner.authSessionId);
        else if (refusal === "connect_disabled") deps.relay.closeOwnedView(owner, viewId, "connect_disabled");
      }).finally(() => {
        checking = false;
      });
    }, heartbeatMs);
    timer.unref?.();
    return timer;
  }

  return {
    /** `GET /api/connect/devices`. */
    async listDevices(request: Request): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      try {
        const records = await deps.repository.listDevices(owner.userId);
        return json({ devices: records.map((record) => deps.relay.projectDevice(record)) });
      } catch (error) {
        return unavailable(error, "read");
      }
    },

    /** `DELETE /api/connect/devices/<deviceId>`: the row goes and its streams end at once. */
    async revokeDevice(request: Request, context: Params<"deviceId">): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const { deviceId } = await context.params;
      if (!isConnectId(deviceId)) return notFound();
      try {
        if (!(await deps.repository.deleteDevice({ id: deviceId, userId: owner.userId }))) return notFound();
      } catch (error) {
        return unavailable(error, "delete");
      }
      deps.relay.disconnectDevice(deviceId, "connect_unauthorized");
      deps.relay.notifyDevicesChanged(owner.userId);
      logConnect({ code: "connect_device_revoked", outcome: "completed", stage: "delete" });
      return noContent();
    },

    /**
     * `GET /api/connect/events`: a `devices` snapshot, then `device` updates
     * and a new snapshot whenever a device is added or removed; `closed` when
     * the session or the switch ends it.
     */
    async events(request: Request): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const userId = owner.userId;
      if (!deps.relay.acquireEventsStream(userId)) return connectRateLimited(headers, CONNECT_HEARTBEAT_SECONDS);
      const stream = createConnectSseStream({ maxQueuedBytes: CONNECT_EVENTS_STREAM_QUEUE_BYTES, signal: request.signal });
      let timer: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: (() => void) | undefined;
      let ready = false;
      let refreshing = false;
      let refreshAgain = false;
      let stale = false;
      stream.onClose(() => {
        if (timer) clearInterval(timer);
        unsubscribe?.();
        deps.relay.releaseEventsStream(userId);
      });

      const snapshot = async (): Promise<void> => {
        const records = await deps.repository.listDevices(userId);
        if (stream.isClosed()) return;
        // Projected now: every relay event before this point is part of it.
        if (!stream.send("devices", { devices: records.map((record) => deps.relay.projectDevice(record)) })) {
          stream.close();
          return;
        }
        ready = true;
        stale = false;
      };
      const refresh = async (): Promise<void> => {
        if (refreshing) {
          refreshAgain = true;
          return;
        }
        refreshing = true;
        try {
          do {
            refreshAgain = false;
            await snapshot();
          } while (refreshAgain && !stream.isClosed());
        } catch {
          stale = true;
        } finally {
          refreshing = false;
        }
      };

      unsubscribe = deps.relay.onEvent((event) => {
        if (stream.isClosed()) return;
        if (event.type === "closed") {
          stream.close({ data: { code: event.code }, event: "closed" });
          return;
        }
        if (event.userId !== userId) return;
        if (event.type === "devices_changed") {
          void refresh();
          return;
        }
        if (!ready) return;
        if (!stream.send("device", { device: event.device })) stream.close();
      });

      refreshing = true;
      try {
        await snapshot();
      } catch (error) {
        stream.close();
        return unavailable(error, "read");
      } finally {
        refreshing = false;
      }
      if (refreshAgain) void refresh();
      let checking = false;
      timer = setInterval(() => {
        if (!stream.send("ping", {})) {
          stream.close();
          return;
        }
        if (checking) return;
        checking = true;
        void streamAuthority(owner).then((refusal) => {
          if (refusal) stream.close({ data: { code: refusal }, event: "closed" });
          else if (stale) void refresh();
        }).finally(() => {
          checking = false;
        });
      }, heartbeatMs);
      timer.unref?.();
      if (stream.isClosed()) clearInterval(timer);
      return stream.response;
    },

    /** `POST /api/connect/devices/<deviceId>/sessions`. */
    async createSession(request: Request, context: Params<"deviceId">): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const { deviceId } = await context.params;
      if (!isConnectId(deviceId)) return notFound();
      const value = await body(request);
      if (value instanceof Response) return value;
      const parsed = connectSessionCreateRequestSchema.safeParse(value);
      if (!parsed.success) return refuse("connect_request_invalid");
      const result = await deviceRequest<"session_create">(owner, deviceId, {
        cwd: parsed.data.cwd,
        program: parsed.data.program,
        ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
        type: "session_create"
      });
      return result instanceof Response ? result : json(result, 201);
    },

    /** `DELETE /api/connect/devices/<deviceId>/sessions/<sessionId>`. */
    async killSession(request: Request, context: Params<"deviceId" | "sessionId">): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const { deviceId, sessionId } = await context.params;
      if (!isConnectId(deviceId) || !CONNECT_SESSION_ID_PATTERN.test(sessionId)) return notFound();
      const result = await deviceRequest<"session_kill">(owner, deviceId, { sessionId, type: "session_kill" });
      return result instanceof Response ? result : noContent();
    },

    /** `GET …/sessions/<sessionId>/history`. */
    async history(request: Request, context: Params<"deviceId" | "sessionId">): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const { deviceId, sessionId } = await context.params;
      if (!isConnectId(deviceId) || !CONNECT_SESSION_ID_PATTERN.test(sessionId)) return notFound();
      const result = await deviceRequest<"session_history">(owner, deviceId, { sessionId, type: "session_history" });
      return result instanceof Response ? result : json(result);
    },

    /** `GET …/sessions/<sessionId>/options`. */
    async options(request: Request, context: Params<"deviceId" | "sessionId">): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const { deviceId, sessionId } = await context.params;
      if (!isConnectId(deviceId) || !CONNECT_SESSION_ID_PATTERN.test(sessionId)) return notFound();
      const result = await deviceRequest<"session_options">(owner, deviceId, { sessionId, type: "session_options" });
      return result instanceof Response ? result : json(result);
    },

    /** `GET /api/connect/devices/<deviceId>/recent-dirs`. */
    async recentDirs(request: Request, context: Params<"deviceId">): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const { deviceId } = await context.params;
      if (!isConnectId(deviceId)) return notFound();
      const result = await deviceRequest<"recent_dirs">(owner, deviceId, { type: "recent_dirs" });
      return result instanceof Response ? result : json(result);
    },

    /** `POST /api/connect/views`: a view belongs to this account and this browser session. */
    async createView(request: Request): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const value = await body(request);
      if (value instanceof Response) return value;
      const parsed = connectViewCreateRequestSchema.safeParse(value);
      if (!parsed.success) return refuse("connect_request_invalid");
      const opened = deps.relay.openView({ ...parsed.data, owner });
      if (opened.ok) return json({ viewId: opened.viewId }, 201);
      return opened.code === "connect_device_offline" ? offlineOrMissing(owner, parsed.data.deviceId) : refuse(opened.code);
    },

    /** `GET /api/connect/views/<viewId>/stream`: `output`, `closed {reason}` and `ping`. */
    async viewStream(request: Request, context: Params<"viewId">): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const { viewId } = await context.params;
      if (!isConnectId(viewId)) return notFound();
      const stream = createConnectSseStream({ maxQueuedBytes: CONNECT_VIEW_STREAM_QUEUE_BYTES, signal: request.signal });
      const attached = deps.relay.attachView({ owner, viewId, writer: stream });
      if (!attached.ok) {
        stream.close();
        return notFound();
      }
      const timer = viewStreamHeartbeat(owner, viewId, attached.writerId, stream);
      stream.onClose(() => {
        clearInterval(timer);
        deps.relay.detachView(viewId, attached.writerId);
      });
      return stream.response;
    },

    /** `POST /api/connect/views/<viewId>/input`. */
    async viewInput(request: Request, context: Params<"viewId">): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const { viewId } = await context.params;
      if (!isConnectId(viewId)) return notFound();
      const value = await body(request, CONNECT_INPUT_BODY_BYTES);
      if (value instanceof Response) return value;
      const data = typeof value === "object" && value !== null ? (value as { data?: unknown }).data : undefined;
      if (typeof data === "string" && connectUtf8ByteLength(data) > CONNECT_MAX_INPUT_BYTES) return refuse("connect_input_too_large");
      const parsed = connectViewInputRequestSchema.safeParse(value);
      if (!parsed.success) return refuse("connect_request_invalid");
      const refusal = deps.relay.viewInput(owner, viewId, parsed.data.data);
      return refusal ? refuse(refusal) : noContent();
    },

    /** `POST /api/connect/views/<viewId>/resize`. */
    async viewResize(request: Request, context: Params<"viewId">): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const { viewId } = await context.params;
      if (!isConnectId(viewId)) return notFound();
      const value = await body(request);
      if (value instanceof Response) return value;
      const parsed = connectViewResizeRequestSchema.safeParse(value);
      if (!parsed.success) return refuse("connect_request_invalid");
      const refusal = deps.relay.viewResize(owner, viewId, parsed.data);
      return refusal ? refuse(refusal) : noContent();
    },

    /** `POST /api/connect/views/<viewId>/visibility`: keeps notifications for an on-screen session quiet. */
    async viewVisibility(request: Request, context: Params<"viewId">): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const { viewId } = await context.params;
      if (!isConnectId(viewId)) return notFound();
      const value = await body(request);
      if (value instanceof Response) return value;
      const parsed = connectViewVisibilityRequestSchema.safeParse(value);
      if (!parsed.success) return refuse("connect_request_invalid");
      const refusal = deps.relay.viewVisibility(owner, viewId, parsed.data.visible);
      return refusal ? refuse(refusal) : noContent();
    },

    /** `DELETE /api/connect/views/<viewId>`. */
    async deleteView(request: Request, context: Params<"viewId">): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const { viewId } = await context.params;
      if (!isConnectId(viewId)) return notFound();
      const refusal = deps.relay.closeOwnedView(owner, viewId);
      return refusal ? refuse(refusal) : noContent();
    },

    /** `GET /api/connect/pairings/by-code/<userCode>`. */
    async lookupPairing(request: Request, context: Params<"userCode">): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const limited = await codeAttempt(owner);
      if (limited) return limited;
      const { userCode } = await context.params;
      try {
        const pairing = await deps.pairing.lookup(userCode);
        return pairing ? json(pairing) : refuse("connect_pairing_expired");
      } catch (error) {
        return unavailable(error, "read");
      }
    },

    /** `POST /api/connect/pairings/by-code/<userCode>` `{decision}`. */
    async decidePairing(request: Request, context: Params<"userCode">): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const limited = await codeAttempt(owner);
      if (limited) return limited;
      const value = await body(request);
      if (value instanceof Response) return value;
      const parsed = connectPairingDecisionRequestSchema.safeParse(value);
      if (!parsed.success) return refuse("connect_request_invalid");
      const { userCode } = await context.params;
      let outcome: Awaited<ReturnType<ConnectPairingService["decide"]>>;
      try {
        outcome = await deps.pairing.decide({
          authSessionId: owner.authSessionId,
          decision: parsed.data.decision,
          userCode,
          userId: owner.userId
        });
      } catch (error) {
        return unavailable(error, "write");
      }
      switch (outcome) {
        case "approved":
        case "denied":
          return json({ status: outcome } satisfies ConnectPairingDecisionResponse);
        case "device_limit":
          return refuse("connect_device_limit");
        case "unauthorized":
          return refuse("connect_unauthorized");
        case "expired":
          return refuse("connect_pairing_expired");
      }
    }
  };
}
