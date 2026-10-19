import packageMetadata from "@/package.json";
import {
  CONNECT_DEFAULT_HELLO_LIMITS,
  CONNECT_HEARTBEAT_SECONDS,
  CONNECT_MAX_EVENTS_BODY_BYTES,
  CONNECT_PROTOCOL_VERSION,
  CONNECT_VERSION_PATTERN,
  connectDeviceEventBatchSchema,
  connectPairingCreateRequestSchema,
  connectPairingPollRequestSchema,
  type ConnectHello
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
/** The oldest client this server speaks to; only a protocol change raises it. */
export const CONNECT_MIN_CLIENT_VERSION = "0.3.20";
/** `lastSeenAt` moves at most this often, so an online device does not rewrite its row per heartbeat. */
export const CONNECT_LAST_SEEN_INTERVAL_MS = 60_000;
const STREAM_ATTACH_ATTEMPTS = 3;
/**
 * Clients whose address cannot be resolved (behind a proxy AIQSA is not told to trust) share one
 * pairing budget, as sign-in goes on without a per-address limit there: refusing them would make
 * pairing impossible on such an installation.
 */
const UNRESOLVED_CLIENT_KEY = "unresolved";

export type ConnectDeviceHandlerDeps = Readonly<{
  /** The client's rate-limit identity; null when a configured proxy hides it. */
  clientKey: (request: Request) => string | null;
  heartbeatMs?: number;
  now?: () => Date;
  pairing: Pick<ConnectPairingService, "create" | "poll">;
  policy: Pick<ConnectPolicyGate, "enabled">;
  rateLimits: Readonly<{ create: LoginRateLimiter; poll: LoginRateLimiter }>;
  relay: Pick<ConnectRelay,
    "acceptEvents" | "attachDevice" | "closeDeviceStream" | "detachDevice" | "epoch" | "hasDeviceStream" | "markDeviceSeen">;
  repository: Pick<ConnectRepository, "findStreamDevice" | "touchDevice">;
}>;

function hello(deviceId: string): ConnectHello {
  return {
    deviceId,
    limits: CONNECT_DEFAULT_HELLO_LIMITS,
    minClientVersion: CONNECT_MIN_CLIENT_VERSION,
    protocol: CONNECT_PROTOCOL_VERSION,
    serverVersion: CONNECT_SERVER_VERSION
  };
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
 * address), the command stream and event posts (the device's Bearer token
 * only). Requests from browsers, which carry `Origin`, are refused.
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
    const client = deps.clientKey(request) ?? UNRESOLVED_CLIENT_KEY;
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
      const batch = connectDeviceEventBatchSchema.safeParse(body.value);
      if (!batch.success) return connectRefusal("connect_request_invalid", headers);
      if (!deps.relay.acceptEvents(tokenHash, batch.data.events)) return connectRefusal("connect_stream_required", headers);
      return new Response(null, { headers, status: 204 });
    }
  };
}
