import { randomUUID } from "node:crypto";
import { isComputerPath, type ConnectComputerWire } from "@/lib/contracts/computer";
import {
  CONNECT_HEARTBEAT_SECONDS,
  connectPairingDecisionRequestSchema,
  type ConnectOp,
  type ConnectOpArgs,
  type ConnectPairingDecisionResponse
} from "@/lib/contracts/connect";
import type { LoginRateLimiter } from "../auth/rateLimit";
import type { RequestAuthResolver } from "../auth/requestAuth";
import type { ComputerOps } from "./computerPort";
import {
  CONNECT_BROWSER_HEADERS,
  CONNECT_SMALL_BODY_BYTES,
  computerRefusal,
  connectRateLimited,
  connectRefusal,
  connectUnavailable,
  isConnectId,
  readConnectJson
} from "./http";
import { logConnect } from "./observability";
import type { ConnectPairingService } from "./pairingService";
import type { ConnectPolicyGate } from "./policy";
import type { ConnectRelay } from "./relay";
import type { ConnectRepository } from "./repository";
import { CONNECT_EVENTS_STREAM_QUEUE_BYTES, createConnectSseStream } from "./sse";

export type ConnectBrowserHandlerDeps = Readonly<{
  /** Per account: pairing code lookups and decisions. */
  codeRateLimiter: LoginRateLimiter;
  /** The folder picker's way to the owner's computer; it checks the owner and the switch again. */
  computerOps: Pick<ComputerOps, "call">;
  heartbeatMs?: number;
  now?: () => Date;
  pairing: Pick<ConnectPairingService, "decide" | "lookup">;
  policy: Pick<ConnectPolicyGate, "enabled">;
  relay: Pick<ConnectRelay,
    "acquireEventsStream" | "disconnectDevice" | "notifyDevicesChanged" | "onEvent" | "projectComputer" | "releaseEventsStream">;
  repository: Pick<ConnectRepository, "deleteDevice" | "isAuthSessionActive" | "listDevices">;
  resolveAuth: RequestAuthResolver;
}>;

/** A device-list stream re-reads this long after the last `devices_changed`, once the change has committed. */
export const CONNECT_DEVICES_CHANGED_REREAD_MS = 1_000;
/** The folder picker waits this long for the computer; a slow disk answers `computer_timeout`. */
export const CONNECT_PICKER_OP_TIMEOUT_MS = 10_000;

type Params<T extends string> = Readonly<{ params: Promise<Readonly<Record<T, string>>> }>;
type Owner = Readonly<{ authSessionId: string; userId: string }>;

/**
 * The browser API under `/api/connect` for the signed-in owner of personal
 * devices. Every handler authenticates, checks the installation switch and
 * the owner at the operation; another account's device answers exactly like
 * a missing one, administrators included. Responses are private and never
 * cached; mutations get the proxy's same-origin check.
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

  async function body(request: Request): Promise<unknown | Response> {
    const read = await readConnectJson(request, CONNECT_SMALL_BODY_BYTES);
    return read.ok ? read.value : refuse(read.code);
  }

  /**
   * One folder-picker operation on the owner's computer. It belongs to no
   * run, so it carries a fresh run id that no `run_ended` follows; the
   * browser going away cancels it. Another account's device and a missing
   * one answer the same `connect_device_unavailable` (404).
   */
  async function pickerOp<Op extends ConnectOp>(
    request: Request,
    owner: Owner,
    deviceId: string,
    op: Op,
    args: ConnectOpArgs<Op>
  ): Promise<Response> {
    const outcome = await deps.computerOps.call({
      args,
      deviceId,
      op,
      runId: randomUUID(),
      signal: request.signal,
      timeoutMs: CONNECT_PICKER_OP_TIMEOUT_MS,
      userId: owner.userId
    });
    return outcome.ok ? json(outcome.result) : computerRefusal(outcome.code, headers);
  }

  /** The `path` query of a picker route: a bounded path without control characters, or null. */
  function pathQuery(request: Request): string | null {
    const value = new URL(request.url).searchParams.get("path");
    return isComputerPath(value) ? value : null;
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

  return {
    /** `GET /api/connect/devices`. */
    async listDevices(request: Request): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      try {
        const records = await deps.repository.listDevices(owner.userId);
        return json({ computers: records.map((record) => deps.relay.projectComputer(record)) });
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
      if (stream.isClosed()) {
        // The browser went away while it was authorized: nothing subscribes.
        deps.relay.releaseEventsStream(userId);
        return stream.response;
      }
      let timer: ReturnType<typeof setInterval> | undefined;
      let reread: ReturnType<typeof setTimeout> | undefined;
      let ready = false;
      let refreshing = false;
      let refreshAgain = false;
      let stale = false;

      const snapshot = async (): Promise<void> => {
        const records = await deps.repository.listDevices(userId);
        if (stream.isClosed()) return;
        // Projected now: every relay event before this point is part of it.
        const computers: ConnectComputerWire[] = records.map((record) => deps.relay.projectComputer(record));
        if (!stream.send("devices", { computers })) {
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

      const unsubscribe = deps.relay.onEvent((event) => {
        if (stream.isClosed()) return;
        if (event.type === "closed") {
          stream.close({ data: { code: event.code }, event: "closed" });
          return;
        }
        if (event.userId !== userId) return;
        if (event.type === "devices_changed") {
          void refresh();
          // A revocation announces the change inside its transaction; this read follows its commit.
          if (reread) clearTimeout(reread);
          reread = setTimeout(() => {
            reread = undefined;
            if (!stream.isClosed()) void refresh();
          }, CONNECT_DEVICES_CHANGED_REREAD_MS);
          reread.unref?.();
          return;
        }
        if (!ready) return;
        if (!stream.send("device", { computer: event.computer })) stream.close();
      });
      // Registered after the subscription: a stream that closes at any later point releases both exactly once.
      stream.onClose(() => {
        if (timer) clearInterval(timer);
        if (reread) clearTimeout(reread);
        unsubscribe();
        deps.relay.releaseEventsStream(userId);
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

    /** `GET /api/connect/devices/<deviceId>/recent-dirs`: the computer's home and recent working folders. */
    async recentDirs(request: Request, context: Params<"deviceId">): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const { deviceId } = await context.params;
      return pickerOp(request, owner, deviceId, "recent_dirs", {});
    },

    /** `GET /api/connect/devices/<deviceId>/dirs?path=`: one level of subfolders for the folder picker. */
    async listDirs(request: Request, context: Params<"deviceId">): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const { deviceId } = await context.params;
      const path = pathQuery(request);
      if (path === null) return refuse("connect_request_invalid");
      return pickerOp(request, owner, deviceId, "list_dirs", { path });
    },

    /** `GET /api/connect/devices/<deviceId>/stat?path=`: whether the chosen folder exists. */
    async stat(request: Request, context: Params<"deviceId">): Promise<Response> {
      const owner = await authorize(request);
      if (owner instanceof Response) return owner;
      const { deviceId } = await context.params;
      const path = pathQuery(request);
      if (path === null) return refuse("connect_request_invalid");
      return pickerOp(request, owner, deviceId, "stat", { path });
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
