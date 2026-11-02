import { types as pgTypes } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STAND_DATABASE_TYPES, TIMESTAMP_WITHOUT_TIME_ZONE_OID, ensureProductionSearch, parseUtcTimestamp, perplexitySearchConnection } from "./browser-scenarios-stand";

describe("production Search setup and OpenRouter", () => {
  const api = { baseUrl: new URL("http://stand.invalid"), cookie: "session=synthetic" };
  const model = (upstreamModelId: string, adapterKind = "openrouter_chat_completions", enabled = true) => {
    const config = { adapterKind, capabilities: {}, upstreamModelId };
    return { activeConfig: config, activeVersion: 1, displayName: upstreamModelId, draftConfig: config, draftVersion: 1, enabled, id: `model-${upstreamModelId}`,
      updatedAt: "2026-11-02T00:00:00Z" };
  };
  const connection = (id: string, family: string, models: unknown[], live = true) => ({ activeConfig: live ? { apiRoot: "https://openrouter.invalid/api/v1" } : null,
    activeVersion: live ? 1 : 0, credentials: [{ activeVersion: { id: "version-1", revokedAt: null }, enabled: true, id: "key-1" }], defaultCredentialId: "key-1",
    draftConfig: { apiRoot: "https://openrouter.invalid/api/v1" }, enabled: true, family, id, models });
  const stand = (connections: unknown[]) => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
      calls.push(`${init.method ?? "GET"} ${url.pathname}`);
      return url.pathname === "/api/admin/providers" && (init.method ?? "GET") === "GET"
        ? Response.json({ connections }) : Response.json({ error: "unexpected_call" }, { status: 500 });
    }));
    return calls;
  };
  afterEach(() => { vi.unstubAllGlobals(); });

  it("stops before any setup when no live OpenRouter connection holds Perplexity's model, and never runs Quick Setup", async () => {
    for (const connections of [
      [],
      [connection("router", "openrouter", [model("openai/gpt-6-astra")])],
      [connection("router", "openrouter", [model("perplexity/sonar-pro-search", "openrouter_chat_completions", false)])],
      [connection("router", "openrouter", [model("perplexity/sonar-pro-search")], false)],
      [connection("compatible", "openai_compatible", [model("perplexity/sonar-pro-search", "openai_chat_completions_compatible")])]
    ]) {
      const calls = stand(connections);
      await expect(ensureProductionSearch(api, { apiRoot: "https://codex-lb.invalid/v1", deepseekKey: "synthetic", searchModel: "search-model-1",
        secret: "synthetic", report: () => undefined })).rejects.toThrow("research_search_perplexity_perplexity_connection_missing");
      expect(calls).toEqual(["GET /api/admin/providers"]);
      expect(calls.some((call) => call.includes("quick-setup"))).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it("runs OpenRouter's Quick Setup only when the operator's approval brings a key, then reuses what it added", async () => {
    const calls: string[] = [];
    let added = false;
    vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
      const method = init.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      if (url.pathname === "/api/admin/providers" && method === "GET") {
        return Response.json({ connections: added ? [connection("router", "openrouter", [model("perplexity/sonar-pro-search")])] : [] });
      }
      if (url.pathname === "/api/admin/providers/quick-setup" && method === "GET") return Response.json({ providers: [{ provider: "openrouter", stateToken: "state-1" }] });
      if (url.pathname === "/api/admin/providers/quick-setup" && method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({ provider: "openrouter", secret: "synthetic-openrouter" });
        added = true;
        return Response.json({ connectionId: "router", outcome: "ready" });
      }
      return Response.json({ error: "unexpected_call" }, { status: 500 });
    }));
    // Past OpenRouter the next step (the codex-lb search model) is out of this stub, so the setup stops there.
    await expect(ensureProductionSearch(api, { apiRoot: "https://codex-lb.invalid/v1", deepseekKey: "synthetic", openrouterSetupKey: "synthetic-openrouter",
      searchModel: "search-model-1", secret: "synthetic", report: () => undefined })).rejects.toThrow(/research_search_openai_/u);
    expect(calls.filter((call) => call === "POST /api/admin/providers/quick-setup")).toHaveLength(1);
  });

  it("sets up only the selected sources: one engine asks for no OpenRouter, search model or other engine's key", async () => {
    const calls = stand([]);
    await expect(ensureProductionSearch(api, { apiRoot: "https://codex-lb.invalid/v1", secret: "synthetic", sources: ["deepseek"], report: () => undefined }))
      .rejects.toThrow("research_search_deepseek_deepseek_key_required");
    expect(calls).toEqual([]);
    vi.unstubAllGlobals();
    const deepseekOnly = stand([connection("deep", "deepseek", [model("deepseek-chat", "openai_chat_completions_compatible")])]);
    // Past the DeepSeek connection the Search routes are out of this stub, so the setup stops at DeepSeek's own source.
    await expect(ensureProductionSearch(api, { apiRoot: "https://codex-lb.invalid/v1", deepseekKey: "synthetic", secret: "synthetic", sources: ["deepseek"],
      report: () => undefined })).rejects.toThrow(/^browser_scenarios_research_search_deepseek_/u);
    expect(deepseekOnly.every((call) => !call.includes("quick-setup") && !call.includes("/models"))).toBe(true);
    vi.unstubAllGlobals();
    stand([]);
    await expect(ensureProductionSearch(api, { apiRoot: "https://codex-lb.invalid/v1", secret: "synthetic", sources: ["openai"], report: () => undefined }))
      .rejects.toThrow("research_search_openai_model_required");
    await expect(ensureProductionSearch(api, { apiRoot: "https://codex-lb.invalid/v1", secret: "synthetic", sources: [], report: () => undefined }))
      .rejects.toThrow("research_search_sources_invalid");
  });

  it("reuses only a live OpenRouter connection with a key and the exact model on OpenRouter's adapter", async () => {
    const calls = stand([connection("other", "openrouter", [model("openai/gpt-6-astra")]),
      connection("router", "openrouter", [model("openai/gpt-6-astra"), model("perplexity/sonar-pro-search")])]);
    await expect(perplexitySearchConnection(api, "perplexity/sonar-pro-search")).resolves.toBe("router");
    expect(calls).toEqual(["GET /api/admin/providers"]);
  });
});

describe("stand database timestamps", () => {
  it("reads Prisma's timestamp without time zone as UTC whatever the host's zone", () => {
    expect(parseUtcTimestamp("2026-10-30 07:00:00.123").toISOString()).toBe("2026-10-30T07:00:00.123Z");
    expect(parseUtcTimestamp("2026-10-30 07:00:00").toISOString()).toBe("2026-10-30T07:00:00.000Z");
    expect(parseUtcTimestamp("2026-10-30 23:59:59.999999").getTime()).toBe(Date.UTC(2026, 9, 30, 23, 59, 59, 999));
    // node-pg's own parser reads the same text in the host's zone: off by its offset outside UTC (run with TZ=Europe/Istanbul).
    const local = (pgTypes.getTypeParser(TIMESTAMP_WITHOUT_TIME_ZONE_OID, "text") as (value: string) => Date)("2026-10-30 07:00:00.123");
    expect(local.getTime() - Date.UTC(2026, 9, 30, 7, 0, 0, 123)).toBe(local.getTimezoneOffset() * 60_000);
  });

  it("parses timestamp columns through the client's own types and leaves other types to node-pg", () => {
    const timestamp = STAND_DATABASE_TYPES.getTypeParser(TIMESTAMP_WITHOUT_TIME_ZONE_OID, "text") as (value: string) => Date;
    expect(timestamp("2026-10-30 07:00:00.123").toISOString()).toBe("2026-10-30T07:00:00.123Z");
    const integer = STAND_DATABASE_TYPES.getTypeParser(23, "text") as (value: string) => unknown;
    expect(integer("42")).toBe(42);
    expect(parseUtcTimestamp("infinity")).toBe(Infinity);
  });
});
