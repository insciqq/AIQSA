import packageMetadata from "@/package.json";
import {
  CONNECT_DEFAULT_HELLO_V2_LIMITS,
  CONNECT_HEARTBEAT_SECONDS,
  CONNECT_ID_PATTERN,
  CONNECT_MAX_EVENTS_BODY_BYTES,
  CONNECT_MAX_EVENTS_PER_POST,
  CONNECT_PROTOCOL_VERSION,
  CONNECT_VERSION_PATTERN,
  connectDeviceEventBatchV2Schema,
  connectPairingCreateRequestSchema,
  connectPairingPollRequestSchema,
  type ConnectHelloV2
} from "@/lib/contracts/connect";
import { hashToken, verifyTokenHash } from "../auth/token";
import type { LoginRateLimiter } from "../auth/rateLimit";
import {
  CONNECT_DEVICE_HEADERS,
  CONNECT_SMALL_BODY_BYTES,
  connectClientVersion,
  connectDeviceToken,
  connectRateLimited,
  connectRefusal,
  connectUnavailable,
  isConnectProtocol2,
  readConnectJson
} from "./http";
import { logConnect } from "./observability";
import type { ConnectPairingService } from "./pairingService";
import type { ConnectPolicyGate } from "./policy";
import type { ConnectDeviceRecord, ConnectRelay } from "./relay";
import type { ConnectRepository, ConnectStreamDevice } from "./repository";
import { CONNECT_DEVICE_STREAM_QUEUE_BYTES, createConnectSseStream } from "./sse";

/** The application version, announced in `hello`; an unstamped build announces `dev`. */
export const CONNECT_SERVER_VERSION = CONNECT_VERSION_PATTERN.test(packageMetadata.version) ? packageMetadata.version : "dev";
/**
 * The oldest client version this server announces in `hello`. The protocol
 * header already keeps terminal clients out (D-03), so this rises only when
 * protocol 2 clients themselves must be cut off.
 */
export const CONNECT_MIN_CLIENT_VERSION = "0.3.20";
/** `lastSeenAt` moves at most this often, so an online device does not rewrite its row per heartbeat. */
export const CONNECT_LAST_SEEN_INTERVAL_MS = 60_000;
const STREAM_ATTACH_ATTEMPTS = 3;
/** When the client's address cannot be resolved behind a proxy, pairing waits instead of sharing one budget. */
const UNRESOLVED_CLIENT_RETRY_SECONDS = 60;

export type ConnectDeviceHandlerDeps = Readonly<{
  /** The client's rate-limit identity; null when a configured proxy hides it. */
  clientKey: (request: Request) => string | null;
  heartbeatMs?: number;
  now?: () => Date;
  pairing: Pick<ConnectPairingService, "create" | "poll">;
  policy: Pick<ConnectPolicyGate, "enabled">;
  rateLimits: Readonly<{ create: LoginRateLimiter; poll: LoginRateLimiter }>;
  relay: Pick<ConnectRelay,
    | "acceptEvents"
    | "attachDevice"
    | "closeDeviceStream"
    | "detachDevice"
    | "disconnectDevice"
    | "epoch"
    | "hasDeviceStream"
    | "markDeviceSeen"
    | "notifyDevicesChanged"
    | "rejectReplies">;
  repository: Pick<ConnectRepository, "deleteDeviceByToken" | "findStreamDevice" | "touchDevice">;
}>;

function hello(deviceId: string): ConnectHelloV2 {
  return {
    deviceId,
    limits: CONNECT_DEFAULT_HELLO_V2_LIMITS,
    minClientVersion: CONNECT_MIN_CLIENT_VERSION,
    protocol: CONNECT_PROTOCOL_VERSION,
    serverVersion: CONNECT_SERVER_VERSION
  };
}

/**
 * The request ids of `reply` events in a batch that failed validation: those
 * operations fail now instead of waiting for their deadline. Anything else in
 * such a batch is dropped.
 */
function replyRequestIds(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const events = (value as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];
  return events.slice(0, CONNECT_MAX_EVENTS_PER_POST).flatMap((event: unknown) => {
    if (typeof event !== "object" || event === null) return [];
    const { requestId, type } = event as { requestId?: unknown; type?: unknown };
    return type === "reply" && typeof requestId === "string" && CONNECT_ID_PATTERN.test(requestId) ? [requestId] : [];
  });
}

function record(device: ConnectStreamDevice): ConnectDeviceRecord {
  return {
    arch: device.arch,
    clientVersion: device.clientVersion,
    createdAt: device.createdAt,
    hostname: device.hostname,
    id: device.id,
    lastSeenAt: device.lastSeenAt,
    name: device.name,
    os: device.os,
    userId: device.userId
  };
}

/**
 * The device API under `/connect-api/v1`: pairing (no credential, limited per
 * address), the command stream, event posts and the device's own revocation
 * (the device's Bearer token only). Requests from browsers, which carry
 * `Origin`, are refused; a stream of a terminal client (no protocol 2 header)
 * answers 426 so it updates itself (D-03).
 */
export function createConnectDeviceHandlers(deps: ConnectDeviceHandlerDeps) {
  const clock = deps.now ?? (() => new Date());
  const heartbeatMs = deps.heartbeatMs ?? CONNECT_HEARTBEAT_SECONDS * 1000;
  const headers = CONNECT_DEVICE_HEADERS;

  async function disabledRefusal(): Promise<Response | null> {
    try {
      return (await deps.policy.enabled()) ? null : connectRefusal("connect_disabled", headers);
    } catch (error) {
      logConnect({ action: "retry", code: "connect_policy_unavailable", error, outcome: "failed", stage: "read" });
      return connectUnavailable(headers);
    }
  }

  async function rateLimitRefusal(request: Request, limiter: LoginRateLimiter, scope: string): Promise<Response | null> {
    const client = deps.clientKey(request);
    if (!client) return connectRateLimited(headers, UNRESOLVED_CLIENT_RETRY_SECONDS);
    let decision: Awaited<ReturnType<LoginRateLimiter["check"]>>;
    try {
      decision = await limiter.check(`connect:${scope}:${client}`);
    } catch (error) {
      logConnect({ action: "retry", code: "connect_store_unavailable", error, outcome: "failed", stage: "preflight" });
      return connectUnavailable(headers);
    }
    if (decision.allowed) return null;
    logConnect({ action: "wait", code: "connect_rate_limited", outcome: "blocked", stage: "preflight" });
    return connectRateLimited(headers, decision.retryAfterSeconds);
  }

  /** Refreshes `lastSeenAt` at most once a minute, and the client version when the client names a new one. */
  async function refreshed(device: ConnectStreamDevice, version: string | null, now: Date): Promise<ConnectDeviceRecord | null> {
    const current = record(device);
    const versionChanged = version !== null && version !== device.clientVersion;
    const due = device.lastSeenAt === null || now.getTime() - device.lastSeenAt.getTime() >= CONNECT_LAST_SEEN_INTERVAL_MS;
    if (!versionChanged && !due) return current;
    const touched = await deps.repository.touchDevice({
      ...(versionChanged ? { clientVersion: version } : {}),
      id: device.id,
      lastSeenAt: now,
      tokenHash: device.tokenHash
    });
    return touched ? { ...current, clientVersion: versionChanged ? version : current.clientVersion, lastSeenAt: now } : null;
  }

  function heartbeat(input: Readonly<{
    device: ConnectDeviceRecord;
    stream: ReturnType<typeof createConnectSseStream>;
    streamId: string;
    tokenHash: string;
  }>): ReturnType<typeof setInterval> {
    let lastSeen = input.device.lastSeenAt?.getTime() ?? 0;
    let checking = false;
    const timer = setInterval(() => {
      if (!input.stream.send("ping", {})) {
        input.stream.close();
        return;
      }
      const now = clock();
      if (checking || now.getTime() - lastSeen < CONNECT_LAST_SEEN_INTERVAL_MS) return;
      checking = true;
      void (async () => {
        try {
          if (!(await deps.policy.enabled())) {
            deps.relay.closeDeviceStream(input.device.id, input.streamId, "connect_disabled");
            return;
          }
          // The minute's `lastSeenAt` write also proves the device and its account still exist.
          const touched = await deps.repository.touchDevice({ id: input.device.id, lastSeenAt: now, tokenHash: input.tokenHash });
          if (!touched) {
            deps.relay.closeDeviceStream(input.device.id, input.streamId, "connect_unauthorized");
            return;
          }
          lastSeen = now.getTime();
          deps.relay.markDeviceSeen(input.device.id, input.streamId, now);
        } catch {
          // A transient store failure keeps the stream; the next heartbeat checks again.
        } finally {
          checking = false;
        }
      })();
    }, heartbeatMs);
    timer.unref?.();
    return timer;
  }

  return {
    /** `POST /connect-api/v1/pairings`. */
    async createPairing(request: Request): Promise<Response> {
      if (request.headers.has("origin")) return connectRefusal("connect_unauthorized", headers);
      const disabled = await disabledRefusal();
      if (disabled) return disabled;
      const limited = await rateLimitRefusal(request, deps.rateLimits.create, "pairing-create");
      if (limited) return limited;
      const body = await readConnectJson(request, CONNECT_SMALL_BODY_BYTES);
      if (!body.ok) return connectRefusal(body.code, headers);
      const parsed = connectPairingCreateRequestSchema.safeParse(body.value);
      if (!parsed.success) return connectRefusal("connect_request_invalid", headers);
      try {
        return Response.json(await deps.pairing.create(parsed.data), { headers, status: 201 });
      } catch (error) {
        logConnect({ action: "retry", code: "connect_store_unavailable", error, outcome: "failed", stage: "write" });
        return connectUnavailable(headers);
      }
    },

    /** `POST /connect-api/v1/pairings/poll`: the token appears in exactly one response. */
    async pollPairing(request: Request): Promise<Response> {
      if (request.headers.has("origin")) return connectRefusal("connect_unauthorized", headers);
      const disabled = await disabledRefusal();
      if (disabled) return disabled;
      const limited = await rateLimitRefusal(request, deps.rateLimits.poll, "pairing-poll");
      if (limited) return limited;
      const body = await readConnectJson(request, CONNECT_SMALL_BODY_BYTES);
      if (!body.ok) return connectRefusal(body.code, headers);
      const parsed = connectPairingPollRequestSchema.safeParse(body.value);
      if (!parsed.success) return connectRefusal("connect_request_invalid", headers);
      try {
        const result = await deps.pairing.poll(parsed.data);
        return result === "device_limit"
          ? connectRefusal("connect_device_limit", headers)
          : Response.json(result, { headers });
      } catch (error) {
        logConnect({ action: "retry", code: "connect_store_unavailable", error, outcome: "failed", stage: "write" });
        return connectUnavailable(headers);
      }
    },

    /**
     * `GET /connect-api/v1/stream`: checks the token against the database,
     * becomes the device's only stream, sends `hello`, then commands and a
     * ping every heartbeat. Revocation and switch-off end it with `closed`.
     */
    async stream(request: Request): Promise<Response> {
      const token = connectDeviceToken(request);
      if (!token) return connectRefusal("connect_unauthorized", headers);
      if (!isConnectProtocol2(request)) {
        // A terminal client: it installs the manifest's version on this answer.
        logConnect({ action: "skip", code: "connect_client_outdated", outcome: "skipped", stage: "preflight" });
        return connectRefusal("connect_client_outdated", headers);
      }
      const tokenHash = hashToken(token);
      const version = connectClientVersion(request);
      for (let attempt = 0; attempt < STREAM_ATTACH_ATTEMPTS; attempt += 1) {
        const disabled = await disabledRefusal();
        if (disabled) return disabled;
        // A revocation or switch-off after this read makes the attach below stale.
        const epoch = deps.relay.epoch();
        let device: ConnectDeviceRecord | null;
        try {
          const stored = await deps.repository.findStreamDevice(tokenHash);
          device = stored && stored.userActive && verifyTokenHash(token, stored.tokenHash)
            ? await refreshed(stored, version, clock())
            : null;
        } catch (error) {
          logConnect({ action: "retry", code: "connect_store_unavailable", error, outcome: "failed", stage: "read" });
          return connectUnavailable(headers);
        }
        if (!device) {
          // A refused token is the client's to fix (pair again); counted, never an incident.
          logConnect({ action: "skip", code: "connect_unauthorized", outcome: "skipped", stage: "preflight" });
          return connectRefusal("connect_unauthorized", headers);
        }
        const stream = createConnectSseStream({ maxQueuedBytes: CONNECT_DEVICE_STREAM_QUEUE_BYTES, signal: request.signal });
        // A client already gone never replaces the device's current stream.
        if (stream.isClosed()) return stream.response;
        const attached = deps.relay.attachDevice({ epoch, hello: hello(device.id), record: device, tokenHash, writer: stream });
        if (attached.kind === "stale") {
          stream.close();
          continue;
        }
        const timer = heartbeat({ device, stream, streamId: attached.streamId, tokenHash });
        const deviceId = device.id;
        stream.onClose(() => {
          clearInterval(timer);
          deps.relay.detachDevice(deviceId, attached.streamId);
        });
        return stream.response;
      }
      return connectUnavailable(headers);
    },

    /** `POST /connect-api/v1/events`: matched against the open stream in memory, never the database. */
    async events(request: Request): Promise<Response> {
      const token = connectDeviceToken(request);
      if (!token) return connectRefusal("connect_unauthorized", headers);
      const disabled = await disabledRefusal();
      if (disabled) return disabled;
      const tokenHash = hashToken(token);
      if (!deps.relay.hasDeviceStream(tokenHash)) return connectRefusal("connect_stream_required", headers);
      const body = await readConnectJson(request, CONNECT_MAX_EVENTS_BODY_BYTES);
      if (!body.ok) return connectRefusal(body.code, headers);
      const batch = connectDeviceEventBatchV2Schema.safeParse(body.value);
      if (!batch.success) {
        logConnect({ action: "fail", code: "connect_request_invalid", outcome: "failed", stage: "validate" });
        deps.relay.rejectReplies(tokenHash, replyRequestIds(body.value));
        return connectRefusal("connect_request_invalid", headers);
      }
      if (!deps.relay.acceptEvents(tokenHash, batch.data.events)) return connectRefusal("connect_stream_required", headers);
      return new Response(null, { headers, status: 204 });
    },

    /**
     * `DELETE /connect-api/v1/device`: the device revokes itself (D-16), as
     * the owner's Revoke does; its stream ends at once. Idempotent: a token
     * that names no device any more answers the same 204. It works while
     * AIQSA Connect is off, since it only removes access.
     */
    async revokeSelf(request: Request): Promise<Response> {
      const token = connectDeviceToken(request);
      if (!token) return connectRefusal("connect_unauthorized", headers);
      let deleted: Awaited<ReturnType<ConnectRepository["deleteDeviceByToken"]>>;
      try {
        deleted = await deps.repository.deleteDeviceByToken(hashToken(token));
      } catch (error) {
        logConnect({ action: "retry", code: "connect_store_unavailable", error, outcome: "failed", stage: "delete" });
        return connectUnavailable(headers);
      }
      if (deleted) {
        deps.relay.disconnectDevice(deleted.id, "connect_unauthorized");
        deps.relay.notifyDevicesChanged(deleted.userId);
        logConnect({ code: "connect_device_revoked", outcome: "completed", stage: "delete" });
      }
      return new Response(null, { headers, status: 204 });
    }
  };
}
