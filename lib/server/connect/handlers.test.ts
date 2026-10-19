import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECT_CLIENT_VERSION_HEADER,
  CONNECT_MAX_DEVICES_PER_USER,
  CONNECT_MAX_EVENTS_BODY_BYTES,
  CONNECT_MAX_INPUT_BYTES,
  CONNECT_MAX_VIEWS_PER_DEVICE,
  connectDeviceStreamEventSchema,
  connectDevicesResponseSchema,
  connectEventsStreamEventSchema,
  connectPairingCreateResponseSchema,
  connectPairingLookupResponseSchema,
  connectPairingPollResponseSchema,
  connectViewStreamEventSchema,
  type ConnectDeviceEvent,
  type ConnectSession
} from "@/lib/contracts/connect";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { hashToken } from "../auth/token";
import { createConnectAdminPolicyHandlers } from "./adminHandlers";
import { createConnectBrowserHandlers } from "./browserHandlers";
import { createConnectDeviceHandlers } from "./deviceHandlers";
import { createConnectPairingService } from "./pairingService";
import { createConnectRelay, type ConnectDeviceRecord, type ConnectRelayEvent } from "./relay";
import type { ConnectPairingRecord, ConnectRepository } from "./repository";
import { issueConnectDeviceToken } from "./tokens";

const logs = vi.hoisted(() => ({ logEvent: vi.fn() }));
vi.mock("../observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../observability")>()),
  logEvent: logs.logEvent
}));

const ORIGIN = "https://aiqsa.example";

type StoredDevice = ConnectDeviceRecord & Readonly<{ tokenHash: string }>;
type StoredPairing = ConnectPairingRecord & Readonly<{ userCodeHash: string }>;
type StoredSession = { expiresAt: Date; revokedAt: Date | null; userId: string };

/** The repository contract over maps, with the same conditions as the Prisma implementation. */
function memoryStore() {
  const devices = new Map<string, StoredDevice>();
  const pairings = new Map<string, StoredPairing>();
  const users = new Map<string, { role: "admin" | "user"; status: string }>();
  const sessions = new Map<string, StoredSession>();
  const touches: Array<Readonly<{ clientVersion?: string; id: string; lastSeenAt: Date }>> = [];
  const pendingPairing = (pairing: StoredPairing | undefined, now: Date): pairing is StoredPairing =>
    pairing !== undefined && pairing.approvedUserId === null && pairing.deniedAt === null && pairing.consumedAt === null &&
    pairing.expiresAt > now;
  const withoutCode = ({ userCodeHash: _hash, ...pairing }: StoredPairing): ConnectPairingRecord => pairing;
  const withoutToken = ({ tokenHash: _hash, ...device }: StoredDevice): ConnectDeviceRecord => device;
  const ownDevices = (userId: string) => [...devices.values()].filter((device) => device.userId === userId);
  const active = (userId: string) => users.get(userId)?.status === "active";

  const repository: ConnectRepository = {
    async approvePairing(input) {
      const session = sessions.get(input.authSessionId);
      if (!session || session.userId !== input.userId || session.revokedAt || session.expiresAt <= input.now || !active(input.userId)) {
        return "unauthorized";
      }
      const pairing = [...pairings.values()].find((candidate) => candidate.userCodeHash === input.userCodeHash);
      if (!pendingPairing(pairing, input.now)) return "expired";
      const approvals = [...pairings.values()].filter((candidate) =>
        candidate.approvedUserId === input.userId && candidate.consumedAt === null && candidate.expiresAt > input.now).length;
      if (ownDevices(input.userId).length + approvals >= CONNECT_MAX_DEVICES_PER_USER) return "device_limit";
      pairings.set(pairing.id, { ...pairing, approvedUserId: input.userId });
      return "approved";
    },
    async consumePairing(input) {
      const pairing = pairings.get(input.id);
      const userId = pairing?.approvedUserId;
      if (!pairing || !userId || !active(userId)) return { kind: "unavailable" };
      if (ownDevices(userId).length >= CONNECT_MAX_DEVICES_PER_USER) return { kind: "device_limit" };
      if (pairing.consumedAt || pairing.deniedAt || pairing.expiresAt <= input.now) return { kind: "unavailable" };
      pairings.set(pairing.id, { ...pairing, consumedAt: input.now });
      const id = randomUUID();
      devices.set(id, {
        arch: pairing.arch,
        clientVersion: pairing.clientVersion,
        createdAt: input.now,
        hostname: pairing.hostname,
        id,
        lastSeenAt: null,
        name: pairing.name,
        os: pairing.os,
        tokenHash: input.tokenHash,
        userId
      });
      return { deviceId: id, kind: "consumed", userId };
    },
    async createPairing(input) {
      if ([...pairings.values()].some((pairing) => pairing.userCodeHash === input.userCodeHash)) return null;
      const id = randomUUID();
      pairings.set(id, {
        approvedUserId: null,
        arch: input.arch,
        clientVersion: input.clientVersion,
        consumedAt: null,
        createdAt: input.createdAt,
        deniedAt: null,
        expiresAt: input.expiresAt,
        hostname: input.hostname,
        id,
        name: input.name,
        os: input.os,
        pollSecretHash: input.pollSecretHash,
        userCodeHash: input.userCodeHash
      });
      return { id };
    },
    async deleteDevice(input) {
      if (devices.get(input.id)?.userId !== input.userId) return false;
      devices.delete(input.id);
      return true;
    },
    async denyPairing(input) {
      const pairing = [...pairings.values()].find((candidate) => candidate.userCodeHash === input.userCodeHash);
      if (!pendingPairing(pairing, input.now)) return "expired";
      pairings.set(pairing.id, { ...pairing, deniedAt: input.now });
      return "denied";
    },
    async deviceExists(input) {
      return devices.get(input.id)?.userId === input.userId;
    },
    async findPairing(id) {
      const pairing = pairings.get(id);
      return pairing ? withoutCode(pairing) : null;
    },
    async findPairingByCode(userCodeHash) {
      const pairing = [...pairings.values()].find((candidate) => candidate.userCodeHash === userCodeHash);
      return pairing ? withoutCode(pairing) : null;
    },
    async findStreamDevice(tokenHash) {
      const device = [...devices.values()].find((candidate) => candidate.tokenHash === tokenHash);
      return device ? { ...device, userActive: active(device.userId) } : null;
    },
    async isAuthSessionActive(input) {
      const session = sessions.get(input.sessionId);
      return Boolean(session && session.userId === input.userId && !session.revokedAt && session.expiresAt > input.now &&
        active(input.userId));
    },
    async listDevices(userId) {
      return ownDevices(userId)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
        .map(withoutToken);
    },
    async touchDevice(input) {
      const device = devices.get(input.id);
      if (!device || device.tokenHash !== input.tokenHash || !active(device.userId)) return false;
      devices.set(input.id, { ...device, ...(input.clientVersion ? { clientVersion: input.clientVersion } : {}), lastSeenAt: input.lastSeenAt });
      touches.push(input);
      return true;
    }
  };

  function seedDevice(userId: string, name = "Synthetic laptop") {
    const token = issueConnectDeviceToken();
    const id = randomUUID();
    devices.set(id, {
      arch: "amd64",
      clientVersion: "0.3.20",
      createdAt: new Date(Date.now() - devices.size * 1_000 - 60_000),
      hostname: "synthetic-host.local",
      id,
      lastSeenAt: null,
      name,
      os: "linux",
      tokenHash: token.hash,
      userId
    });
    return { id, token: token.value };
  }

  return { devices, pairings, repository, seedDevice, sessions, touches, users };
}

type Frame = Readonly<{ data: unknown; event: string }>;

function frames(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  return {
    async next(): Promise<Frame | null> {
      const { done, value } = await reader.read();
      if (done) return null;
      const match = /^event: ([a-z_]+)\ndata: (.*)\n\n$/su.exec(decoder.decode(value));
      if (!match) throw new Error("not one SSE frame");
      return { data: JSON.parse(match[2]!), event: match[1]! };
    },
    async nextOf(event: string): Promise<Frame | null> {
      for (;;) {
        const frame = await this.next();
        if (frame === null || frame.event === event) return frame;
      }
    },
    close: () => reader.cancel()
  };
}

function setup() {
  const store = memoryStore();
  store.users.set("alice", { role: "user", status: "active" });
  store.users.set("bob", { role: "admin", status: "active" });
  const future = new Date(Date.now() + 86_400_000);
  store.sessions.set("alice-session", { expiresAt: future, revokedAt: null, userId: "alice" });
  store.sessions.set("alice-other-tab", { expiresAt: future, revokedAt: null, userId: "alice" });
  store.sessions.set("bob-session", { expiresAt: future, revokedAt: null, userId: "bob" });
  const policy = { enabled: true };
  const relay = createConnectRelay();
  const relayEvents: ConnectRelayEvent[] = [];
  relay.onEvent((event) => relayEvents.push(event));
  const allowed = () => ({ check: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })), release: vi.fn(), reset: vi.fn() });
  const limits = { code: allowed(), create: allowed(), poll: allowed() };
  const gate = { enabled: vi.fn(async () => policy.enabled) };
  const pairing = createConnectPairingService({
    codeSecret: () => "synthetic-session-secret",
    origin: () => ORIGIN,
    relay,
    repository: store.repository
  });
  const resolveAuth = vi.fn(async (request: Request): Promise<AuthenticatedSession | null> => {
    const id = request.headers.get("x-test-session");
    const session = id ? store.sessions.get(id) : undefined;
    const user = session ? store.users.get(session.userId) : undefined;
    if (!id || !session || !user || session.revokedAt || session.expiresAt <= new Date() || user.status !== "active") return null;
    return {
      expiresAt: session.expiresAt,
      id,
      user: { displayName: "Synthetic", email: null, id: session.userId, role: user.role, status: user.status },
      userId: session.userId
    };
  });
  const clientKey = vi.fn((_request: Request): string | null => "ip:203.0.113.5");
  const device = createConnectDeviceHandlers({
    clientKey,
    pairing,
    policy: gate,
    rateLimits: { create: limits.create, poll: limits.poll },
    relay,
    repository: store.repository
  });
  const browser = createConnectBrowserHandlers({
    codeRateLimiter: limits.code,
    pairing,
    policy: gate,
    relay,
    repository: store.repository,
    resolveAuth
  });
  const admin = createConnectAdminPolicyHandlers({
    onUpdated(updated) {
      policy.enabled = updated.enabled;
      if (!updated.enabled) relay.disable();
    },
    repository: {
      read: async () => ({ enabled: policy.enabled, version: 1 }),
      update: async (input) => ({ kind: "ok", policy: { enabled: input.enabled, version: input.expectedVersion + 1 } })
    },
    resolveAuth
  });
  return { admin, browser, clientKey, device, gate, limits, policy, relay, relayEvents, resolveAuth, store };
}

function deviceRequest(path: string, init: Readonly<{
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
  token?: string;
}> = {}) {
  return new Request(`${ORIGIN}${path}`, {
    ...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers
    },
    method: init.method ?? (init.body === undefined ? "GET" : "POST")
  });
}

function browserRequest(path: string, session: string, init: Readonly<{ body?: unknown; method?: string }> = {}) {
  return new Request(`${ORIGIN}${path}`, {
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    headers: { "content-type": "application/json", "x-test-session": session },
    method: init.method ?? (init.body === undefined ? "GET" : "POST")
  });
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

const machine = { arch: "arm64", clientVersion: "0.3.20", hostname: "studio.local", name: "Studio", os: "darwin" } as const;

async function json(response: Response) {
  return { body: response.status === 204 ? null : await response.json(), status: response.status };
}

function session(id: string, title = "Fix the build", status: ConnectSession["status"] = "running"): ConnectSession {
  return {
    attachedClients: 1,
    createdAt: "2026-10-19T09:00:00.000Z",
    cwd: "/home/synthetic/project",
    id,
    program: "claude",
    status,
    statusAt: "2026-10-19T09:00:00.000Z",
    title
  };
}

async function openDeviceStream(context: ReturnType<typeof setup>, token: string, headers: Record<string, string> = {}) {
  const response = await context.device.stream(deviceRequest("/connect-api/v1/stream", { headers, token }));
  expect(response.status).toBe(200);
  const stream = frames(response);
  const hello = await stream.next();
  expect(connectDeviceStreamEventSchema.parse(hello)).toMatchObject({ event: "hello" });
  return stream;
}

async function postEvents(context: ReturnType<typeof setup>, token: string, events: ConnectDeviceEvent[]) {
  return context.device.events(deviceRequest("/connect-api/v1/events", { body: { events }, token }));
}

async function createView(context: ReturnType<typeof setup>, sessionName: string, deviceId: string, sessionId = "ac-session1") {
  const response = await context.browser.createView(browserRequest("/api/connect/views", sessionName, {
    body: { cols: 100, deviceId, rows: 30, sessionId }
  }));
  expect(response.status).toBe(201);
  return ((await response.json()) as { viewId: string }).viewId;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("AIQSA Connect pairing", () => {
  it("pairs a computer: the owner approves the code and only the first poll after it carries the token", async () => {
    const context = setup();
    const created = await context.device.createPairing(deviceRequest("/connect-api/v1/pairings", { body: machine }));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const pairing = connectPairingCreateResponseSchema.parse(await created.json());
    expect(pairing.verificationUri).toBe(`${ORIGIN}/connect/pair?code=${pairing.userCode}`);
    expect(pairing.intervalSeconds).toBe(2);
    expect(pairing.expiresAt).toBe("2026-10-19T10:10:00.000Z");
    const poll = () => context.device.pollPairing(deviceRequest("/connect-api/v1/pairings/poll", {
      body: { pairingId: pairing.pairingId, pollSecret: pairing.pollSecret }
    }));
    await expect((await poll()).json()).resolves.toEqual({ status: "pending" });

    const lookup = await context.browser.lookupPairing(
      browserRequest(`/api/connect/pairings/by-code/${pairing.userCode}`, "alice-session"),
      params({ userCode: pairing.userCode.toLowerCase().replace("-", "") })
    );
    expect(lookup.status).toBe(200);
    expect(connectPairingLookupResponseSchema.parse(await lookup.json())).toEqual({
      pairing: { ...machine, expiresAt: "2026-10-19T10:10:00.000Z" }
    });
    const approved = await context.browser.decidePairing(
      browserRequest(`/api/connect/pairings/by-code/${pairing.userCode}`, "alice-session", { body: { decision: "approve" } }),
      params({ userCode: pairing.userCode })
    );
    await expect(json(approved)).resolves.toEqual({ body: { status: "approved" }, status: 200 });

    const first = connectPairingPollResponseSchema.parse(await (await poll()).json());
    if (first.status !== "approved") throw new Error("not approved");
    const stored = context.store.devices.get(first.deviceId)!;
    expect(stored).toMatchObject({ hostname: "studio.local", name: "Studio", tokenHash: hashToken(first.deviceToken), userId: "alice" });
    await expect((await poll()).json()).resolves.toEqual({ status: "expired" });
    expect(context.relayEvents).toContainEqual({ type: "devices_changed", userId: "alice" });

    const later = await context.browser.lookupPairing(
      browserRequest(`/api/connect/pairings/by-code/${pairing.userCode}`, "alice-session"),
      params({ userCode: pairing.userCode })
    );
    await expect(json(later)).resolves.toEqual({ body: { code: "connect_pairing_expired" }, status: 404 });
    const stream = await openDeviceStream(context, first.deviceToken);
    await stream.close();
  });

  it("answers denied, expired, foreign secrets and unknown codes with one neutral answer each", async () => {
    const context = setup();
    const create = async () => connectPairingCreateResponseSchema.parse(await (await context.device.createPairing(
      deviceRequest("/connect-api/v1/pairings", { body: machine }))).json());
    const poll = async (pairingId: string, pollSecret: string) => (await context.device.pollPairing(
      deviceRequest("/connect-api/v1/pairings/poll", { body: { pairingId, pollSecret } }))).json();
    const decide = async (userCode: string, decision: "approve" | "deny", session = "alice-session") => json(
      await context.browser.decidePairing(
        browserRequest(`/api/connect/pairings/by-code/${userCode}`, session, { body: { decision } }),
        params({ userCode })
      ));
    const lookup = async (userCode: string) => json(await context.browser.lookupPairing(
      browserRequest(`/api/connect/pairings/by-code/${userCode}`, "alice-session"), params({ userCode })));
    const neutral = { body: { code: "connect_pairing_expired" }, status: 404 };

    const denied = await create();
    await expect(decide(denied.userCode, "deny")).resolves.toEqual({ body: { status: "denied" }, status: 200 });
    await expect(poll(denied.pairingId, denied.pollSecret)).resolves.toEqual({ status: "denied" });
    await expect(lookup(denied.userCode)).resolves.toEqual(neutral);
    await expect(decide(denied.userCode, "approve")).resolves.toEqual(neutral);

    const expired = await create();
    await vi.advanceTimersByTimeAsync(600_001);
    await expect(poll(expired.pairingId, expired.pollSecret)).resolves.toEqual({ status: "expired" });
    await expect(lookup(expired.userCode)).resolves.toEqual(neutral);
    await expect(decide(expired.userCode, "approve")).resolves.toEqual(neutral);

    const pending = await create();
    await expect(poll(pending.pairingId, "A".repeat(43))).resolves.toEqual({ status: "expired" });
    await expect(poll(randomUUID(), pending.pollSecret)).resolves.toEqual({ status: "expired" });
    await expect(lookup("ZZZZ-ZZZZ")).resolves.toEqual(neutral);
    await expect(lookup("not-a-code")).resolves.toEqual(neutral);
    await expect(decide("ZZZZ-ZZZZ", "approve")).resolves.toEqual(neutral);
    await expect(poll(pending.pairingId, pending.pollSecret)).resolves.toEqual({ status: "pending" });
  });

  it("limits pairing per client address and code attempts per account, with retry-after", async () => {
    const context = setup();
    context.limits.create.check.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 42.2 });
    const limited = await context.device.createPairing(deviceRequest("/connect-api/v1/pairings", { body: machine }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("43");
    await expect(limited.json()).resolves.toEqual({ code: "connect_rate_limited" });
    expect(context.limits.create.check).toHaveBeenCalledWith("connect:pairing-create:ip:203.0.113.5");

    context.limits.poll.check.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 3 });
    const polled = await context.device.pollPairing(deviceRequest("/connect-api/v1/pairings/poll", {
      body: { pairingId: randomUUID(), pollSecret: "A".repeat(43) }
    }));
    expect(polled.status).toBe(429);
    expect(polled.headers.get("retry-after")).toBe("3");
    expect(context.limits.poll.check).toHaveBeenCalledWith("connect:pairing-poll:ip:203.0.113.5");

    context.clientKey.mockReturnValueOnce(null);
    const unresolved = await context.device.createPairing(deviceRequest("/connect-api/v1/pairings", { body: machine }));
    expect(unresolved.status).toBe(429);
    expect(unresolved.headers.get("retry-after")).toBe("60");

    context.limits.code.check.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 120 });
    const code = await context.browser.lookupPairing(
      browserRequest("/api/connect/pairings/by-code/ABCD-EFGH", "alice-session"),
      params({ userCode: "ABCD-EFGH" })
    );
    expect(code.status).toBe(429);
    expect(code.headers.get("retry-after")).toBe("120");
    expect(context.limits.code.check).toHaveBeenCalledWith("connect:pairing-code:user:alice");
  });

  it("keeps an account within its device limit at approval and when the approval is consumed", async () => {
    const context = setup();
    for (let index = 0; index < CONNECT_MAX_DEVICES_PER_USER - 1; index += 1) context.store.seedDevice("alice");
    const create = async () => connectPairingCreateResponseSchema.parse(await (await context.device.createPairing(
      deviceRequest("/connect-api/v1/pairings", { body: machine }))).json());
    const approve = async (userCode: string) => json(await context.browser.decidePairing(
      browserRequest(`/api/connect/pairings/by-code/${userCode}`, "alice-session", { body: { decision: "approve" } }),
      params({ userCode })
    ));

    const last = await create();
    const excess = await create();
    await expect(approve(last.userCode)).resolves.toEqual({ body: { status: "approved" }, status: 200 });
    await expect(approve(excess.userCode)).resolves.toEqual({ body: { code: "connect_device_limit" }, status: 409 });

    // A device that appeared in the meantime makes the approval wait at consumption.
    context.store.seedDevice("alice");
    const poll = await context.device.pollPairing(deviceRequest("/connect-api/v1/pairings/poll", {
      body: { pairingId: last.pairingId, pollSecret: last.pollSecret }
    }));
    await expect(json(poll)).resolves.toEqual({ body: { code: "connect_device_limit" }, status: 409 });
  });

  it("refuses an approval from a browser session revoked meanwhile", async () => {
    const context = setup();
    const pairing = connectPairingCreateResponseSchema.parse(await (await context.device.createPairing(
      deviceRequest("/connect-api/v1/pairings", { body: machine }))).json());
    context.resolveAuth.mockImplementationOnce(async () => ({
      expiresAt: new Date(Date.now() + 60_000),
      id: "alice-session",
      user: { displayName: "Synthetic", email: null, id: "alice", role: "user", status: "active" },
      userId: "alice"
    }));
    context.store.sessions.get("alice-session")!.revokedAt = new Date();
    const answer = await context.browser.decidePairing(
      browserRequest(`/api/connect/pairings/by-code/${pairing.userCode}`, "alice-session", { body: { decision: "approve" } }),
      params({ userCode: pairing.userCode })
    );
    await expect(json(answer)).resolves.toEqual({ body: { code: "connect_unauthorized" }, status: 401 });
  });
});

describe("AIQSA Connect device API", () => {
  it("refuses browser requests and malformed tokens before any lookup", async () => {
    const context = setup();
    const { token } = context.store.seedDevice("alice");
    const lookup = vi.spyOn(context.store.repository, "findStreamDevice");
    for (const request of [
      deviceRequest("/connect-api/v1/stream", { headers: { origin: ORIGIN }, token }),
      deviceRequest("/connect-api/v1/stream", { token: `${token}x` }),
      deviceRequest("/connect-api/v1/stream", { headers: { authorization: `Basic ${token}` } }),
      deviceRequest("/connect-api/v1/stream", { headers: { cookie: "aiqsa_session=opaque" } })
    ]) {
      await expect(json(await context.device.stream(request))).resolves.toEqual({ body: { code: "connect_unauthorized" }, status: 401 });
    }
    expect(lookup).not.toHaveBeenCalled();
    for (const handler of [context.device.createPairing, context.device.pollPairing, context.device.events]) {
      const response = await handler(deviceRequest("/connect-api/v1/pairings", { body: machine, headers: { origin: ORIGIN }, token }));
      expect(response.status).toBe(401);
    }
    const revoked = issueConnectDeviceToken().value;
    await expect(json(await context.device.stream(deviceRequest("/connect-api/v1/stream", { token: revoked }))))
      .resolves.toEqual({ body: { code: "connect_unauthorized" }, status: 401 });
  });

  it("opens with hello, refreshes lastSeenAt at most once a minute and records the client version it names", async () => {
    const context = setup();
    const { id, token } = context.store.seedDevice("alice");
    const stream = await openDeviceStream(context, token, { [CONNECT_CLIENT_VERSION_HEADER]: "0.3.21" });
    expect(context.store.touches).toEqual([{ clientVersion: "0.3.21", id, lastSeenAt: new Date("2026-10-19T10:00:00.000Z"), tokenHash: hashToken(token) }]);
    expect(context.store.devices.get(id)?.clientVersion).toBe("0.3.21");

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(stream.next()).resolves.toEqual({ data: {}, event: "ping" });
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(stream.nextOf("ping")).resolves.toEqual({ data: {}, event: "ping" });
    expect(context.store.touches).toHaveLength(2);
    expect(context.store.touches[1]).toMatchObject({ lastSeenAt: new Date("2026-10-19T10:01:00.000Z") });
    await stream.close();

    const again = await openDeviceStream(context, token, { [CONNECT_CLIENT_VERSION_HEADER]: "banana" });
    expect(context.store.touches).toHaveLength(2);
    expect(context.store.devices.get(id)?.clientVersion).toBe("0.3.21");
    await again.close();
  });

  it("lets a second stream replace the first", async () => {
    const context = setup();
    const { token } = context.store.seedDevice("alice");
    const first = await openDeviceStream(context, token);
    const second = await openDeviceStream(context, token);

    await expect(first.next()).resolves.toEqual({ data: {}, event: "replaced" });
    await expect(first.next()).resolves.toBeNull();
    await second.close();
  });

  it("ends the stream with connect_unauthorized when the owner revokes the device", async () => {
    const context = setup();
    const { id, token } = context.store.seedDevice("alice");
    const stream = await openDeviceStream(context, token);

    const revoked = await context.browser.revokeDevice(
      browserRequest(`/api/connect/devices/${id}`, "alice-session", { method: "DELETE" }),
      params({ deviceId: id })
    );
    expect(revoked.status).toBe(204);
    await expect(stream.next()).resolves.toEqual({ data: { code: "connect_unauthorized" }, event: "closed" });
    await expect(stream.next()).resolves.toBeNull();
    await expect(json(await context.device.stream(deviceRequest("/connect-api/v1/stream", { token }))))
      .resolves.toEqual({ body: { code: "connect_unauthorized" }, status: 401 });
  });

  it("ends a stream whose device or account disappears at the next minute's check", async () => {
    const context = setup();
    const { id, token } = context.store.seedDevice("alice");
    const stream = await openDeviceStream(context, token);
    context.store.devices.delete(id);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(stream.nextOf("closed")).resolves.toEqual({ data: { code: "connect_unauthorized" }, event: "closed" });
  });

  it("ends every stream, view and device list with connect_disabled when the administrator turns it off", async () => {
    const context = setup();
    const { id, token } = context.store.seedDevice("alice");
    const deviceStream = await openDeviceStream(context, token);
    const events = frames(await context.browser.events(browserRequest("/api/connect/events", "alice-session")));
    await events.next();
    const viewId = await createView(context, "alice-session", id);
    const view = frames(await context.browser.viewStream(
      browserRequest(`/api/connect/views/${viewId}/stream`, "alice-session"), params({ viewId })));

    const patched = await context.admin.PATCH(new Request(`${ORIGIN}/api/admin/connect`, {
      body: JSON.stringify({ enabled: false, expectedVersion: 1 }),
      headers: { "content-type": "application/json", "x-test-session": "bob-session" },
      method: "PATCH"
    }));
    expect(patched.status).toBe(200);

    await expect(deviceStream.nextOf("closed")).resolves.toEqual({ data: { code: "connect_disabled" }, event: "closed" });
    await expect(events.nextOf("closed")).resolves.toEqual({ data: { code: "connect_disabled" }, event: "closed" });
    await expect(view.nextOf("closed")).resolves.toEqual({ data: { reason: "connect_disabled" }, event: "closed" });
    for (const response of [
      await context.device.stream(deviceRequest("/connect-api/v1/stream", { token })),
      await context.device.events(deviceRequest("/connect-api/v1/events", { body: { events: [] }, token })),
      await context.device.createPairing(deviceRequest("/connect-api/v1/pairings", { body: machine })),
      await context.browser.listDevices(browserRequest("/api/connect/devices", "alice-session")),
      await context.browser.events(browserRequest("/api/connect/events", "alice-session"))
    ]) {
      await expect(json(response)).resolves.toEqual({ body: { code: "connect_disabled" }, status: 403 });
    }
  });

  it("needs an open stream for events and keeps one device's events away from another device's views and requests", async () => {
    const context = setup();
    const alice = context.store.seedDevice("alice");
    const bob = context.store.seedDevice("bob");
    await expect(json(await postEvents(context, alice.token, [{ sessions: [], type: "sessions" }])))
      .resolves.toEqual({ body: { code: "connect_stream_required" }, status: 409 });

    const aliceStream = await openDeviceStream(context, alice.token);
    const bobStream = await openDeviceStream(context, bob.token);
    const viewId = await createView(context, "alice-session", alice.id);
    const view = frames(await context.browser.viewStream(
      browserRequest(`/api/connect/views/${viewId}/stream`, "alice-session"), params({ viewId })));
    const history = context.browser.history(
      browserRequest(`/api/connect/devices/${alice.id}/sessions/ac-session1/history`, "alice-session"),
      params({ deviceId: alice.id, sessionId: "ac-session1" })
    );
    await aliceStream.next();
    const command = (await aliceStream.next())!.data as { requestId: string; type: string };
    expect(command.type).toBe("session_history");

    expect((await postEvents(context, bob.token, [
      { data: "Zm9yZ2Vk", seq: 0, type: "output", viewId },
      { ok: true, requestId: command.requestId, result: { text: "forged" }, type: "reply" }
    ])).status).toBe(204);
    expect((await postEvents(context, alice.token, [
      { data: "cmVhbA==", seq: 0, type: "output", viewId },
      { ok: true, requestId: command.requestId, result: { text: "real history" }, type: "reply" }
    ])).status).toBe(204);

    await expect(view.next()).resolves.toEqual({ data: { data: "cmVhbA==", seq: 0 }, event: "output" });
    await expect(json(await history)).resolves.toEqual({ body: { text: "real history" }, status: 200 });
    await bobStream.close();
  });

  it("bounds and validates event batches", async () => {
    const context = setup();
    const { token } = context.store.seedDevice("alice");
    await openDeviceStream(context, token);

    const tooLarge = await context.device.events(deviceRequest("/connect-api/v1/events", {
      body: `{"events":[{"type":"sessions","sessions":[]}],"pad":"${"x".repeat(CONNECT_MAX_EVENTS_BODY_BYTES)}"}`,
      token
    }));
    await expect(json(tooLarge)).resolves.toEqual({ body: { code: "connect_input_too_large" }, status: 413 });
    for (const body of ["{", { events: [] }, { events: [{ type: "unknown" }] }, [{ sessions: [], type: "sessions" }]]) {
      const response = await context.device.events(deviceRequest("/connect-api/v1/events", { body, token }));
      await expect(json(response)).resolves.toEqual({ body: { code: "connect_request_invalid" }, status: 400 });
    }
  });

  it("answers an unreachable store with a retryable 503 that names nothing", async () => {
    const context = setup();
    const { token } = context.store.seedDevice("alice");
    vi.spyOn(context.store.repository, "findStreamDevice").mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    vi.spyOn(context.store.repository, "listDevices").mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    // The stream and the list reach their store; the pairing request finds the switch unreadable.
    context.gate.enabled
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432"));

    for (const response of [
      await context.device.stream(deviceRequest("/connect-api/v1/stream", { token })),
      await context.browser.listDevices(browserRequest("/api/connect/devices", "alice-session")),
      await context.device.createPairing(deviceRequest("/connect-api/v1/pairings", { body: machine }))
    ]) {
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      await expect(response.text()).resolves.toBe("");
    }
    expect(JSON.stringify(logs.logEvent.mock.calls)).not.toContain("10.0.0.5");
    expect(logs.logEvent).toHaveBeenCalledWith("service_operation", expect.objectContaining({ code: "connect_store_unavailable" }));
    expect(logs.logEvent).toHaveBeenCalledWith("service_operation", expect.objectContaining({ code: "connect_policy_unavailable" }));
  });
});

describe("AIQSA Connect browser API isolation", () => {
  it("answers another account's devices, sessions and views exactly like missing ones, for administrators too", async () => {
    const context = setup();
    const online = context.store.seedDevice("alice", "Online laptop");
    const offline = context.store.seedDevice("alice", "Offline desktop");
    await openDeviceStream(context, online.token);
    const viewId = await createView(context, "alice-session", online.id);

    const responses = async (deviceId: string, view: string) => {
      const sessionId = "ac-session1";
      const all = [
        await context.browser.revokeDevice(browserRequest(`/api/connect/devices/${deviceId}`, "bob-session", { method: "DELETE" }), params({ deviceId })),
        await context.browser.createSession(
          browserRequest(`/api/connect/devices/${deviceId}/sessions`, "bob-session", { body: { cwd: "~", program: "shell" } }),
          params({ deviceId })
        ),
        await context.browser.killSession(
          browserRequest(`/api/connect/devices/${deviceId}/sessions/${sessionId}`, "bob-session", { method: "DELETE" }),
          params({ deviceId, sessionId })
        ),
        await context.browser.history(
          browserRequest(`/api/connect/devices/${deviceId}/sessions/${sessionId}/history`, "bob-session"),
          params({ deviceId, sessionId })
        ),
        await context.browser.options(
          browserRequest(`/api/connect/devices/${deviceId}/sessions/${sessionId}/options`, "bob-session"),
          params({ deviceId, sessionId })
        ),
        await context.browser.recentDirs(browserRequest(`/api/connect/devices/${deviceId}/recent-dirs`, "bob-session"), params({ deviceId })),
        await context.browser.createView(browserRequest("/api/connect/views", "bob-session", {
          body: { cols: 80, deviceId, rows: 24, sessionId }
        })),
        await context.browser.viewStream(browserRequest(`/api/connect/views/${view}/stream`, "bob-session"), params({ viewId: view })),
        await context.browser.viewInput(
          browserRequest(`/api/connect/views/${view}/input`, "bob-session", { body: { data: "rm -rf /\r" } }),
          params({ viewId: view })
        ),
        await context.browser.viewResize(
          browserRequest(`/api/connect/views/${view}/resize`, "bob-session", { body: { cols: 80, rows: 24 } }),
          params({ viewId: view })
        ),
        await context.browser.viewVisibility(
          browserRequest(`/api/connect/views/${view}/visibility`, "bob-session", { body: { visible: true } }),
          params({ viewId: view })
        ),
        await context.browser.deleteView(browserRequest(`/api/connect/views/${view}`, "bob-session", { method: "DELETE" }), params({ viewId: view }))
      ];
      for (const response of all) expect(response.headers.get("cache-control")).toBe("private, no-store");
      return Promise.all(all.map(json));
    };

    const missing = await responses(randomUUID(), randomUUID());
    expect(missing.every((answer) => answer.status === 404 && answer.body.code === "connect_not_found")).toBe(true);
    await expect(responses(online.id, viewId)).resolves.toEqual(missing);
    await expect(responses(offline.id, viewId)).resolves.toEqual(missing);
    expect(context.store.devices.has(online.id)).toBe(true);
    const listed = connectDevicesResponseSchema.parse(await (await context.browser.listDevices(
      browserRequest("/api/connect/devices", "bob-session"))).json());
    expect(listed.devices).toEqual([]);
    // The view still belongs to its owner.
    expect((await context.browser.viewVisibility(
      browserRequest(`/api/connect/views/${viewId}/visibility`, "alice-session", { body: { visible: true } }),
      params({ viewId })
    )).status).toBe(204);
  });

  it("answers missing sessions with not found and an offline device with its own code", async () => {
    const context = setup();
    const offline = context.store.seedDevice("alice");
    const history = await context.browser.history(
      browserRequest(`/api/connect/devices/${offline.id}/sessions/ac-session1/history`, "alice-session"),
      params({ deviceId: offline.id, sessionId: "ac-session1" })
    );
    await expect(json(history)).resolves.toEqual({ body: { code: "connect_device_offline" }, status: 409 });
    const malformed = await context.browser.history(
      browserRequest(`/api/connect/devices/${offline.id}/sessions/not-a-session/history`, "alice-session"),
      params({ deviceId: offline.id, sessionId: "not-a-session" })
    );
    await expect(json(malformed)).resolves.toEqual({ body: { code: "connect_not_found" }, status: 404 });
    const anonymous = await context.browser.listDevices(new Request(`${ORIGIN}/api/connect/devices`));
    await expect(json(anonymous)).resolves.toEqual({ body: { code: "connect_unauthorized" }, status: 401 });
  });
});

describe("AIQSA Connect sessions and views", () => {
  it("relays commands to the device, its replies to the browser and its errors with their codes", async () => {
    const context = setup();
    const { id, token } = context.store.seedDevice("alice");
    const deviceStream = await openDeviceStream(context, token);
    const reply = async (result: Record<string, unknown>) => {
      const command = (await deviceStream.nextOf("command"))!.data as { requestId: string };
      await postEvents(context, token, [{ requestId: command.requestId, type: "reply", ...result } as ConnectDeviceEvent]);
      return command;
    };

    const created = context.browser.createSession(
      browserRequest(`/api/connect/devices/${id}/sessions`, "alice-session", { body: { cwd: "~/work", program: "claude", title: "Fix the build" } }),
      params({ deviceId: id })
    );
    expect(await reply({ ok: true, result: { sessionId: "ac-new123" } })).toMatchObject({
      cwd: "~/work", program: "claude", title: "Fix the build", type: "session_create"
    });
    await expect(json(await created)).resolves.toEqual({ body: { sessionId: "ac-new123" }, status: 201 });

    const limited = context.browser.createSession(
      browserRequest(`/api/connect/devices/${id}/sessions`, "alice-session", { body: { cwd: "/srv", program: "shell" } }),
      params({ deviceId: id })
    );
    await reply({ code: "connect_session_limit", ok: false });
    await expect(json(await limited)).resolves.toEqual({ body: { code: "connect_session_limit" }, status: 409 });

    const options = context.browser.options(
      browserRequest(`/api/connect/devices/${id}/sessions/ac-new123/options`, "alice-session"),
      params({ deviceId: id, sessionId: "ac-new123" })
    );
    await reply({ ok: true, result: { options: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }] } });
    await expect(json(await options)).resolves.toEqual({ body: { options: [{ key: "1", label: "Yes" }, { key: "2", label: "No" }] }, status: 200 });

    const dirs = context.browser.recentDirs(browserRequest(`/api/connect/devices/${id}/recent-dirs`, "alice-session"), params({ deviceId: id }));
    await reply({ ok: true, result: { dirs: ["/home/synthetic/work"], home: "/home/synthetic" } });
    await expect(json(await dirs)).resolves.toEqual({ body: { dirs: ["/home/synthetic/work"], home: "/home/synthetic" }, status: 200 });

    const killed = context.browser.killSession(
      browserRequest(`/api/connect/devices/${id}/sessions/ac-new123`, "alice-session", { method: "DELETE" }),
      params({ deviceId: id, sessionId: "ac-new123" })
    );
    await reply({ code: "connect_session_not_found", ok: false });
    await expect(json(await killed)).resolves.toEqual({ body: { code: "connect_session_not_found" }, status: 404 });

    const slow = context.browser.history(
      browserRequest(`/api/connect/devices/${id}/sessions/ac-new123/history`, "alice-session"),
      params({ deviceId: id, sessionId: "ac-new123" })
    );
    await deviceStream.nextOf("command");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(json(await slow)).resolves.toEqual({ body: { code: "connect_device_timeout" }, status: 504 });
  });

  it("sends input in order to the device and output only to the owning view", async () => {
    const context = setup();
    const { id, token } = context.store.seedDevice("alice");
    const deviceStream = await openDeviceStream(context, token);
    const viewId = await createView(context, "alice-session", id, "ac-session1");
    expect((await deviceStream.next())!.data).toEqual({ cols: 100, rows: 30, sessionId: "ac-session1", type: "view_open", viewId });
    const otherTab = await createView(context, "alice-other-tab", id, "ac-session1");
    await deviceStream.next();
    const view = frames(await context.browser.viewStream(
      browserRequest(`/api/connect/views/${viewId}/stream`, "alice-session"), params({ viewId })));
    const other = frames(await context.browser.viewStream(
      browserRequest(`/api/connect/views/${otherTab}/stream`, "alice-other-tab"), params({ viewId: otherTab })));
    // A view belongs to the browser session that opened it.
    expect((await context.browser.viewStream(
      browserRequest(`/api/connect/views/${viewId}/stream`, "alice-other-tab"), params({ viewId }))).status).toBe(404);

    for (const data of ["echo one", "\r", "\u001b[A"]) {
      const sent = await context.browser.viewInput(
        browserRequest(`/api/connect/views/${viewId}/input`, "alice-session", { body: { data } }), params({ viewId }));
      expect(sent.status).toBe(204);
    }
    expect((await context.browser.viewResize(
      browserRequest(`/api/connect/views/${viewId}/resize`, "alice-session", { body: { cols: 50, rows: 20 } }), params({ viewId }))).status).toBe(204);
    const commands = [await deviceStream.next(), await deviceStream.next(), await deviceStream.next(), await deviceStream.next()];
    expect(commands.map((frame) => frame!.data)).toEqual([
      { data: "echo one", type: "view_input", viewId },
      { data: "\r", type: "view_input", viewId },
      { data: "\u001b[A", type: "view_input", viewId },
      { cols: 50, rows: 20, type: "view_resize", viewId }
    ]);

    await postEvents(context, token, [
      { data: "b25l", seq: 0, type: "output", viewId },
      { data: "dHdv", seq: 0, type: "output", viewId: otherTab }
    ]);
    expect(connectViewStreamEventSchema.parse(await view.next())).toEqual({ data: { data: "b25l", seq: 0 }, event: "output" });
    await expect(other.next()).resolves.toEqual({ data: { data: "dHdv", seq: 0 }, event: "output" });

    const tooLarge = await context.browser.viewInput(
      browserRequest(`/api/connect/views/${viewId}/input`, "alice-session", { body: { data: "x".repeat(CONNECT_MAX_INPUT_BYTES + 1) } }),
      params({ viewId })
    );
    await expect(json(tooLarge)).resolves.toEqual({ body: { code: "connect_input_too_large" }, status: 413 });
    const closed = await context.browser.deleteView(
      browserRequest(`/api/connect/views/${viewId}`, "alice-session", { method: "DELETE" }), params({ viewId }));
    expect(closed.status).toBe(204);
    await expect(view.next()).resolves.toEqual({ data: { reason: "detached" }, event: "closed" });
    await expect(deviceStream.next()).resolves.toEqual({ data: { type: "view_close", viewId }, event: "command" });
  });

  it("closes a view nobody streams after thirty seconds and enforces the view limit", async () => {
    const context = setup();
    const { id, token } = context.store.seedDevice("alice");
    const deviceStream = await openDeviceStream(context, token);
    const orphan = await createView(context, "alice-session", id);
    await deviceStream.next();

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(deviceStream.nextOf("command")).resolves.toEqual({ data: { type: "view_close", viewId: orphan }, event: "command" });
    expect((await context.browser.viewStream(
      browserRequest(`/api/connect/views/${orphan}/stream`, "alice-session"), params({ viewId: orphan }))).status).toBe(404);

    for (let index = 0; index < CONNECT_MAX_VIEWS_PER_DEVICE; index += 1) await createView(context, "alice-session", id);
    const limited = await context.browser.createView(browserRequest("/api/connect/views", "alice-session", {
      body: { cols: 80, deviceId: id, rows: 24, sessionId: "ac-session1" }
    }));
    await expect(json(limited)).resolves.toEqual({ body: { code: "connect_view_limit" }, status: 409 });
  });

  it("closes a revoked browser session's views and device list at the next heartbeat", async () => {
    const context = setup();
    const { id, token } = context.store.seedDevice("alice");
    const deviceStream = await openDeviceStream(context, token);
    const viewId = await createView(context, "alice-session", id);
    const view = frames(await context.browser.viewStream(
      browserRequest(`/api/connect/views/${viewId}/stream`, "alice-session"), params({ viewId })));
    const list = frames(await context.browser.events(browserRequest("/api/connect/events", "alice-session")));
    await list.next();

    // Logout revokes the session row; nothing else is told.
    context.store.sessions.get("alice-session")!.revokedAt = new Date();
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(view.nextOf("closed")).resolves.toEqual({ data: { reason: "connect_unauthorized" }, event: "closed" });
    await expect(list.nextOf("closed")).resolves.toEqual({ data: { code: "connect_unauthorized" }, event: "closed" });
    await expect(deviceStream.nextOf("command")).resolves.toMatchObject({ data: { type: "view_open" } });
    await expect(deviceStream.nextOf("command")).resolves.toEqual({ data: { type: "view_close", viewId }, event: "command" });
    const input = await context.browser.viewInput(
      browserRequest(`/api/connect/views/${viewId}/input`, "alice-session", { body: { data: "x" } }), params({ viewId }));
    expect(input.status).toBe(401);
  });

  it("tells the relay which session the owner has on screen", async () => {
    const context = setup();
    const { id, token } = context.store.seedDevice("alice");
    await openDeviceStream(context, token);
    const viewId = await createView(context, "alice-session", id, "ac-session1");
    frames(await context.browser.viewStream(browserRequest(`/api/connect/views/${viewId}/stream`, "alice-session"), params({ viewId })));

    const hidden = await context.browser.viewVisibility(
      browserRequest(`/api/connect/views/${viewId}/visibility`, "alice-session", { body: { visible: false } }), params({ viewId }));
    expect(hidden.status).toBe(204);
    expect(context.relay.isSessionVisible("alice", id, "ac-session1", Date.now())).toBe(false);
    await context.browser.viewVisibility(
      browserRequest(`/api/connect/views/${viewId}/visibility`, "alice-session", { body: { visible: true } }), params({ viewId }));
    expect(context.relay.isSessionVisible("alice", id, "ac-session1", Date.now())).toBe(true);
    expect(context.relay.isSessionVisible("bob", id, "ac-session1", Date.now())).toBe(false);
  });
});

describe("AIQSA Connect device list stream", () => {
  it("sends a snapshot, device updates, and a new snapshot when a device is added or removed", async () => {
    const context = setup();
    const laptop = context.store.seedDevice("alice", "Laptop");
    const list = frames(await context.browser.events(browserRequest("/api/connect/events", "alice-session")));
    const bobList = frames(await context.browser.events(browserRequest("/api/connect/events", "bob-session")));
    const first = connectEventsStreamEventSchema.parse(await list.next());
    expect(first).toMatchObject({ data: { devices: [{ id: laptop.id, name: "Laptop", online: false, sessions: [] }] }, event: "devices" });
    await expect(bobList.next()).resolves.toEqual({ data: { devices: [] }, event: "devices" });

    await openDeviceStream(context, laptop.token);
    expect(connectEventsStreamEventSchema.parse(await list.next())).toMatchObject({ data: { device: { id: laptop.id, online: true } }, event: "device" });
    await postEvents(context, laptop.token, [{ sessions: [session("ac-session1", "Fix the build")], type: "sessions" }]);
    expect(connectEventsStreamEventSchema.parse(await list.next())).toMatchObject({
      data: { device: { online: true, sessions: [{ id: "ac-session1", title: "Fix the build" }] } },
      event: "device"
    });
    await postEvents(context, laptop.token, [{ reason: "turn_end", sessionId: "ac-session1", status: "waiting", statusAt: "2026-10-19T10:00:05.000Z", type: "status" }]);
    expect(await list.next()).toMatchObject({ data: { device: { sessions: [{ status: "waiting", statusAt: "2026-10-19T10:00:05.000Z" }] } }, event: "device" });

    const pairing = connectPairingCreateResponseSchema.parse(await (await context.device.createPairing(
      deviceRequest("/connect-api/v1/pairings", { body: machine }))).json());
    await context.browser.decidePairing(
      browserRequest(`/api/connect/pairings/by-code/${pairing.userCode}`, "alice-session", { body: { decision: "approve" } }),
      params({ userCode: pairing.userCode })
    );
    await context.device.pollPairing(deviceRequest("/connect-api/v1/pairings/poll", {
      body: { pairingId: pairing.pairingId, pollSecret: pairing.pollSecret }
    }));
    const added = connectEventsStreamEventSchema.parse(await list.nextOf("devices"));
    expect(added.event === "devices" && added.data.devices.map((device) => device.name)).toEqual(["Laptop", "Studio"]);

    await context.browser.revokeDevice(
      browserRequest(`/api/connect/devices/${laptop.id}`, "alice-session", { method: "DELETE" }), params({ deviceId: laptop.id }));
    await expect(list.next()).resolves.toMatchObject({ data: { device: { id: laptop.id, online: false } }, event: "device" });
    const removed = connectEventsStreamEventSchema.parse(await list.nextOf("devices"));
    expect(removed.event === "devices" && removed.data.devices.map((device) => device.name)).toEqual(["Studio"]);

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(list.next()).resolves.toEqual({ data: {}, event: "ping" });
    // Nothing of Alice's reached Bob's list.
    await expect(bobList.next()).resolves.toEqual({ data: {}, event: "ping" });
  });
});

describe("AIQSA Connect logging", () => {
  it("records codes and counts only: no terminal data, paths, titles, names, tokens or pairing codes", async () => {
    const context = setup();
    const created = connectPairingCreateResponseSchema.parse(await (await context.device.createPairing(
      deviceRequest("/connect-api/v1/pairings", { body: { ...machine, hostname: "secret-host.example", name: "Secret Machine" } }))).json());
    await context.browser.decidePairing(
      browserRequest(`/api/connect/pairings/by-code/${created.userCode}`, "alice-session", { body: { decision: "approve" } }),
      params({ userCode: created.userCode })
    );
    const approved = connectPairingPollResponseSchema.parse(await (await context.device.pollPairing(
      deviceRequest("/connect-api/v1/pairings/poll", { body: { pairingId: created.pairingId, pollSecret: created.pollSecret } }))).json());
    if (approved.status !== "approved") throw new Error("not approved");
    const deviceStream = await openDeviceStream(context, approved.deviceToken);
    await postEvents(context, approved.deviceToken, [{ sessions: [session("ac-secret1", "Secret title")], type: "sessions" }]);
    const viewId = await createView(context, "alice-session", approved.deviceId, "ac-secret1");
    await context.browser.viewInput(
      browserRequest(`/api/connect/views/${viewId}/input`, "alice-session", { body: { data: "secret typed password" } }), params({ viewId }));
    await postEvents(context, approved.deviceToken, [
      { data: "c2VjcmV0IG91dHB1dA==", seq: 0, type: "output", viewId },
      { data: "Z2Fw", seq: 3, type: "output", viewId }
    ]);
    context.limits.code.check.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 5 });
    await context.browser.lookupPairing(browserRequest("/api/connect/pairings/by-code/ABCD-EFGH", "alice-session"), params({ userCode: "ABCD-EFGH" }));
    const history = context.browser.history(
      browserRequest(`/api/connect/devices/${approved.deviceId}/sessions/ac-secret1/history`, "alice-session"),
      params({ deviceId: approved.deviceId, sessionId: "ac-secret1" })
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await history;
    await context.device.stream(deviceRequest("/connect-api/v1/stream", { token: issueConnectDeviceToken().value }));
    await deviceStream.close();

    expect(logs.logEvent).toHaveBeenCalled();
    const logged = JSON.stringify(logs.logEvent.mock.calls);
    for (const secret of [
      "secret-host", "Secret Machine", "Secret title", "secret typed", "c2VjcmV0", "/home/synthetic", approved.deviceToken,
      approved.deviceId, created.userCode, created.pollSecret, created.pairingId, viewId, "alice"
    ]) {
      expect(logged).not.toContain(secret);
    }
    for (const [event, fields] of logs.logEvent.mock.calls) {
      expect(event).toBe("service_operation");
      expect(fields).toMatchObject({ subsystem: "connect" });
      expect(String((fields as { code: string }).code)).toMatch(/^connect_[a-z_]+$/u);
    }
  });
});
