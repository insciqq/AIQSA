import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { decodeDiscordMonitoringKeyCreated, decodeDiscordMonitoringKeyList, type DiscordMonitoringTelemetry } from "@/lib/contracts/discord";
import { proxyWithEnv } from "../../../proxy";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { createAdminDiscordActivityHandler, discordActivityStats, type DiscordJournalStats } from "./activity";
import {
  createAdminDiscordMonitoringKeyHandlers, createDiscordMonitoringHandlers, discordFailureRatio, discordMcpServerLabel, formatDiscordMetrics,
  hashDiscordMonitoringSecret, matchesDiscordKeyHash, newDiscordMonitoringSecret, parseDiscordMonitoringWindow, type DiscordHourLoad,
  type DiscordMonitoringKeyStore
} from "./monitoring";

vi.mock("../observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../observability")>();
  return { ...actual, logEvent: vi.fn() };
});

const NOW = new Date("2026-11-12T12:00:00.000Z");
const SECRET = "aiqsa_dmk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function session(role: string, status = "active"): AuthenticatedSession {
  return {
    expiresAt: new Date("2026-11-13T00:00:00.000Z"), id: "session-1", userId: "admin-1",
    user: { displayName: "Admin", email: "admin@example.invalid", id: "admin-1", role, status }
  };
}

function telemetry(window: Readonly<{ since: Date; until: Date }>): DiscordMonitoringTelemetry {
  const latency = { p50Ms: 1_200, p95Ms: 4_000 };
  return {
    compactions: 1, delivered: 3, failed: 1, failuresByCode: [{ code: "discord_busy", count: 1 }], generatedAt: NOW.toISOString(), interrupted: 0,
    latency: { acked: latency, admitted: latency, delivered: latency, firstStatus: latency }, limitHits: { author: 1, key: 0, thread: 0 },
    mcpByServer: [{ calls: 4, errors: 1, server: "Tracker" }], notFound: 1,
    problems: [{
      channelId: "1100000000000000010", chatId: "chat-1", code: "discord_busy", guildId: "1100000000000000001", kind: "failed", latencyMs: null,
      limitKind: null, messageLink: "https://discord.com/channels/1100000000000000001/1100000000000000010/1100000000000000030",
      questionMessageId: "1100000000000000030", receivedAt: "2026-11-12T11:00:00.000Z", test: false
    }],
    ratingsDown: 1, ratingsUp: 2, requests: 5, since: window.since.toISOString(), subagents: 0, until: window.until.toISOString()
  };
}

function monitoring(verify: DiscordMonitoringKeyStore["verify"] = async (secret) => secret === SECRET) {
  const read = vi.fn(async (window: Readonly<{ since: Date; until: Date }>) => telemetry(window));
  const metrics = vi.fn(async () => "aiqsa_discord_enabled 1\n");
  return { handlers: createDiscordMonitoringHandlers({ keys: { verify }, metrics, now: () => NOW, telemetry: read }), metrics, read };
}

const get = (path: string, authorization?: string) => new Request(`https://aiqsa.example.com${path}`, {
  headers: authorization ? { authorization } : {}
});

describe("Discord monitoring endpoints", () => {
  it("answer 404 without a valid key, the same for missing, malformed, unknown and revoked keys", async () => {
    const { handlers, read } = monitoring();
    const bodies: string[] = [];
    for (const authorization of [undefined, "Basic abc", "Bearer short", `Bearer ${SECRET}x`, `Bearer ${SECRET.replace("A", "B")}`]) {
      for (const response of [await handlers.telemetry(get("/api/monitoring/discord", authorization)),
        await handlers.metrics(get("/api/monitoring/discord/metrics", authorization))]) {
        expect(response.status).toBe(404);
        bodies.push(await response.text());
      }
    }
    expect(new Set(bodies).size).toBe(1);
    expect(read).not.toHaveBeenCalled();
  });

  it("serve the telemetry of the requested window, the last 24 hours by default, and the metrics as Prometheus text", async () => {
    const { handlers, read } = monitoring();
    const response = await handlers.telemetry(get("/api/monitoring/discord", `Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(read).toHaveBeenLastCalledWith({ since: new Date(NOW.getTime() - 86_400_000), until: NOW }, NOW);
    expect(await response.json()).toMatchObject({ requests: 5, problems: [{ kind: "failed" }] });

    await handlers.telemetry(get("/api/monitoring/discord?since=2026-11-01T00:00:00Z&until=2026-11-08T00:00:00.000Z", `Bearer ${SECRET}`));
    expect(read).toHaveBeenLastCalledWith({ since: new Date("2026-11-01T00:00:00.000Z"), until: new Date("2026-11-08T00:00:00.000Z") }, NOW);

    const metrics = await handlers.metrics(get("/api/monitoring/discord/metrics", `Bearer ${SECRET}`));
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(await metrics.text()).toBe("aiqsa_discord_enabled 1\n");
  });

  it("refuse a window longer than 31 days, reversed or malformed, after the key", async () => {
    const { handlers } = monitoring();
    for (const query of ["?since=2026-09-01T00:00:00Z", "?since=2026-11-12T13:00:00Z", "?since=yesterday", "?since=1&since=2"]) {
      const response = await handlers.telemetry(get(`/api/monitoring/discord${query}`, `Bearer ${SECRET}`));
      expect(response.status, query).toBe(400);
      expect(await response.json()).toEqual({ error: "discord_monitoring_window_invalid" });
    }
    expect(parseDiscordMonitoringWindow(new URLSearchParams("since=2026-10-12T12:00:00Z"), NOW)).toEqual({
      since: new Date("2026-10-12T12:00:00.000Z"), until: NOW
    });
    expect(parseDiscordMonitoringWindow(new URLSearchParams("since=2026-10-12T11:59:59Z"), NOW)).toBeNull();
  });

  it("fail visibly with a code when the keys cannot be read", async () => {
    const { handlers } = monitoring(async () => { throw new Error("database down"); });
    const response = await handlers.metrics(get("/api/monitoring/discord/metrics", `Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "discord_monitoring_failed" });
  });

  it("are public by path only under /api/monitoring", () => {
    const env = { AIQSA_APP_BASE_URL: "https://aiqsa.example.com" };
    for (const path of ["/api/monitoring/discord", "/api/monitoring/discord/metrics"]) {
      const response = proxyWithEnv(new NextRequest(`https://aiqsa.example.com${path}`), env);
      expect(response.headers.get("x-middleware-next"), path).toBe("1");
    }
    expect(proxyWithEnv(new NextRequest("https://aiqsa.example.com/api/monitoringx"), env).status).toBe(401);
  });
});

describe("Discord metrics", () => {
  const hour: DiscordHourLoad = {
    people: { failures: 3, latencyP95Ms: 7_250, limitHits: { author: 2, key: 1, thread: 0 }, requests: 12 },
    test: { failures: 1, latencyP95Ms: null, limitHits: { author: 0, key: 0, thread: 0 }, requests: 4 }
  };

  it("carry the PRD metric names, test labels where they count requests, and NaN for what is unknown", () => {
    const text = formatDiscordMetrics({ connected: true, enabled: true, hour, lastEventAt: new Date(NOW.getTime() - 4_500), now: NOW });
    const samples = text.split("\n").filter((line) => line && !line.startsWith("#"));
    expect(samples).toEqual([
      "aiqsa_discord_enabled 1",
      "aiqsa_discord_gateway_connected 1",
      "aiqsa_discord_last_event_age_seconds 4.5",
      `aiqsa_discord_requests_1h{test="false"} 12`,
      `aiqsa_discord_requests_1h{test="true"} 4`,
      `aiqsa_discord_failures_1h{test="false"} 3`,
      `aiqsa_discord_failures_1h{test="true"} 1`,
      "aiqsa_discord_failure_ratio_1h 0.25",
      "aiqsa_discord_latency_p95_seconds_1h 7.25",
      `aiqsa_discord_limit_hits_1h{kind="author",test="false"} 2`,
      `aiqsa_discord_limit_hits_1h{kind="author",test="true"} 0`,
      `aiqsa_discord_limit_hits_1h{kind="thread",test="false"} 0`,
      `aiqsa_discord_limit_hits_1h{kind="thread",test="true"} 0`,
      `aiqsa_discord_limit_hits_1h{kind="key",test="false"} 1`,
      `aiqsa_discord_limit_hits_1h{kind="key",test="true"} 0`
    ]);
    expect(text).toContain("# TYPE aiqsa_discord_gateway_connected gauge\n");
    const idle = formatDiscordMetrics({
      connected: false, enabled: false, hour: { people: hour.test, test: hour.test }, lastEventAt: null, now: NOW
    });
    expect(idle).toContain("aiqsa_discord_last_event_age_seconds NaN\n");
    expect(idle).toContain("aiqsa_discord_latency_p95_seconds_1h NaN\n");
    expect(discordFailureRatio({ failures: 0, requests: 0 })).toBe(0);
  });
});

describe("Discord MCP server labels", () => {
  it("show an administrator's name without control or formatting characters, bounded, and `other` for nothing", () => {
    expect(discordMcpServerLabel("Tracker\u0007  tools\u202e")).toBe("Tracker tools");
    expect(discordMcpServerLabel("x".repeat(150))).toBe("x".repeat(100));
    expect(discordMcpServerLabel("\u200b ")).toBe("other");
    expect(discordMcpServerLabel(null)).toBe("other");
  });
});

describe("Discord monitoring keys", () => {
  function store() {
    const keys = new Map<string, { id: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; hash: string }>();
    let next = 0;
    const api: Omit<DiscordMonitoringKeyStore, "verify"> = {
      async create({ keyHash, now }) {
        if ([...keys.values()].filter((key) => !key.revokedAt).length >= 5) return "limit";
        const id = `key-${++next}`;
        keys.set(id, { createdAt: now.toISOString(), hash: keyHash, id, lastUsedAt: null, revokedAt: null });
        return { createdAt: now.toISOString(), id, lastUsedAt: null, revokedAt: null };
      },
      async list() {
        return [...keys.values()].map(({ hash: _hash, ...key }) => key);
      },
      async revoke({ id, now }) {
        const key = keys.get(id);
        if (!key) return false;
        key.revokedAt ??= now.toISOString();
        return true;
      }
    };
    return { api, keys };
  }

  it("are for active administrators only", async () => {
    const { api } = store();
    for (const [resolved, status] of [[null, 401], [session("member"), 403], [session("admin", "disabled"), 403]] as const) {
      const handlers = createAdminDiscordMonitoringKeyHandlers({ keys: api, resolveAuth: async () => resolved });
      expect((await handlers.GET(get("/api/admin/discord/monitoring-keys"))).status).toBe(status);
      expect((await handlers.POST(get("/api/admin/discord/monitoring-keys"))).status).toBe(status);
      expect((await handlers.DELETE(get("/api/admin/discord/monitoring-keys/key-1"), "key-1")).status).toBe(status);
    }
  });

  it("show the secret once, keep only its hash, stop at five active keys and revoke", async () => {
    const { api, keys } = store();
    const handlers = createAdminDiscordMonitoringKeyHandlers({ keys: api, now: () => NOW, resolveAuth: async () => session("admin") });
    const created = await handlers.POST(get("/api/admin/discord/monitoring-keys"));
    expect(created.status).toBe(201);
    const body = decodeDiscordMonitoringKeyCreated(await created.json())!;
    expect(body.secret).toMatch(/^aiqsa_dmk_/u);
    expect(keys.get(body.key.id)!.hash).toBe(hashDiscordMonitoringSecret(body.secret));
    const listed = await (await handlers.GET(get("/api/admin/discord/monitoring-keys"))).text();
    expect(listed).not.toContain(body.secret);
    expect(listed).not.toContain(hashDiscordMonitoringSecret(body.secret));
    for (let index = 0; index < 4; index += 1) expect((await handlers.POST(get("/api/admin/discord/monitoring-keys"))).status).toBe(201);
    const refused = await handlers.POST(get("/api/admin/discord/monitoring-keys"));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "discord_monitoring_key_limit" });

    const revoked = await handlers.DELETE(get(`/api/admin/discord/monitoring-keys/${body.key.id}`), body.key.id);
    expect(revoked.status).toBe(200);
    expect(decodeDiscordMonitoringKeyList(await revoked.json())!.keys.find((key) => key.id === body.key.id)!.revokedAt).toBe(NOW.toISOString());
    expect((await handlers.DELETE(get("/api/admin/discord/monitoring-keys/key-404"), "key-404")).status).toBe(404);
    expect((await handlers.DELETE(get("/api/admin/discord/monitoring-keys/x"), "../x")).status).toBe(404);
  });

  it("match a secret's hash among the active ones in constant time per candidate", () => {
    const secret = newDiscordMonitoringSecret();
    expect(secret).toMatch(/^aiqsa_dmk_[A-Za-z0-9_-]{43}$/u);
    const hash = hashDiscordMonitoringSecret(secret);
    expect(matchesDiscordKeyHash(hash, [hashDiscordMonitoringSecret(SECRET), hash])).toBe(1);
    expect(matchesDiscordKeyHash(hash, [hashDiscordMonitoringSecret(SECRET)])).toBe(-1);
    expect(matchesDiscordKeyHash(hash, [])).toBe(-1);
  });
});

describe("Discord activity route", () => {
  const stats: DiscordJournalStats = {
    compactions: 0, delivered: 2, failed: 1, failuresByCode: [{ code: "discord_busy", count: 1 }], interrupted: 1,
    latency: {
      acked: { p50Ms: 100, p95Ms: 200 }, admitted: { p50Ms: 300, p95Ms: 400 }, delivered: { p50Ms: 5_000, p95Ms: 9_000 },
      firstStatus: { p50Ms: 500, p95Ms: 600 }
    },
    limitHits: { author: 1, key: 0, thread: 0 }, notFound: 1, ratingsDown: 1, ratingsUp: 1, requests: 5, subagents: 0
  };

  it("serves the summaries and rows to active administrators only", async () => {
    const activity = { last24h: discordActivityStats(stats), last7d: discordActivityStats(stats), rows: [] };
    expect(activity.last24h.latency).toEqual({ p50Ms: 5_000, p95Ms: 9_000 });
    const read = vi.fn(async () => activity);
    expect((await createAdminDiscordActivityHandler({ read, resolveAuth: async () => null })(get("/api/admin/discord/activity"))).status).toBe(401);
    expect((await createAdminDiscordActivityHandler({ read, resolveAuth: async () => session("member") })(get("/api/admin/discord/activity"))).status)
      .toBe(403);
    expect(read).not.toHaveBeenCalled();
    const response = await createAdminDiscordActivityHandler({ now: () => NOW, read, resolveAuth: async () => session("admin") })(
      get("/api/admin/discord/activity"));
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledWith(NOW);
    expect(await response.json()).toEqual(activity);
    const failing = createAdminDiscordActivityHandler({ read: async () => { throw new Error("down"); }, resolveAuth: async () => session("admin") });
    expect((await failing(get("/api/admin/discord/activity"))).status).toBe(503);
  });
});
