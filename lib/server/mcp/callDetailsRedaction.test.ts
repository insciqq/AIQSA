import type { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptMcpEnvelope, mcpOAuthClientSecretEnvelopeContext, mcpOAuthTokenEnvelopeContext, mcpPersonalConfigEnvelopeContext,
  mcpRuntimeGenerationEnvelopeContext, mcpSharedConfigEnvelopeContext } from "./encryption";
import { mcpCallDisplayRedaction } from "./callDetailsRedaction";
import { projectMcpCallDetails, type McpCallDetailRecord } from "./callDetails";

const key = Buffer.alloc(32, 7);
const identity = { serverId: "server", revisionId: "revision", fingerprint: "a".repeat(64), originalName: "read" };
const configuration = { auth: { mode: "static" }, runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 30_000 },
  source: { kind: "remote", url: "https://example.com/mcp" }, transport: "streamable_http", slots: [{ label: "Token",
    policy: { allowPersonalOverride: true, kind: "shared" }, sensitive: true, slotKey: "token",
    target: { kind: "header", name: "Authorization" }, valueType: "secret" }] };
const oauthConfiguration = { ...configuration, auth: { mode: "oauth", scopes: [], allowedAuthorizationServerOrigins: [] }, slots: [] };
const generation = { id: "generation", fingerprint: identity.fingerprint, effectiveConfigEnvelope:
  encryptMcpEnvelope({ version: 1, values: { token: "synthetic-secret" }, plan: [] }, key,
    mcpRuntimeGenerationEnvelopeContext("generation", identity.fingerprint)), oauthConnection: null };
const sharedServer = (value: string | null, version = 1) => ({ id: "server", sharedConfigVersion: version, activeRevision: null,
  sharedConfigEnvelope: value === null ? null : encryptMcpEnvelope({ version: 1, values: { token: value } }, key,
    mcpSharedConfigEnvelopeContext("server", version)) });
const personalServer = (value: string, version = 1) => ({ id: "user-server", personalConfigVersion: version,
  personalConfigEnvelope: encryptMcpEnvelope({ version: 1, values: { token: value } }, key,
    mcpPersonalConfigEnvelopeContext("user-server", version)) });
function oauthConnection(id: string, tokenGeneration: number, access: string, clientSecretGeneration = 1) {
  return { id, userId: "user", serverId: "server", tokenGeneration,
    tokenEnvelope: encryptMcpEnvelope({ version: 1, tokens: { access_token: access, refresh_token: `${access}-refresh` } }, key,
      mcpOAuthTokenEnvelopeContext(id, tokenGeneration)),
    oauthClient: { id: "client", clientSecretGeneration, clientSecretEnvelope: encryptMcpEnvelope({ version: 1, clientSecret: "synthetic-client" }, key,
      mcpOAuthClientSecretEnvelopeContext("client", clientSecretGeneration)) } };
}

type Rows = { revision?: unknown; server?: unknown; generation?: unknown; personal?: unknown; connections?: unknown[] };
function fixture(rows: Rows = {}) {
  const calls = {
    revision: vi.fn(async () => "revision" in rows ? rows.revision : { configuration }),
    server: vi.fn(async () => "server" in rows ? rows.server : sharedServer(null)),
    generation: vi.fn(async () => "generation" in rows ? rows.generation : generation),
    personal: vi.fn(async () => rows.personal ?? null),
    connections: vi.fn(async () => rows.connections ?? [])
  };
  const tx = { mcpRevision: { findFirst: calls.revision }, mcpServer: { findFirst: calls.server },
    mcpRuntimeGeneration: { findFirst: calls.generation }, mcpUserServer: { findUnique: calls.personal },
    mcpOAuthConnection: { findMany: calls.connections } } as unknown as Prisma.TransactionClient;
  vi.stubEnv("AIQSA_ENCRYPTION_KEY", key.toString("base64"));
  return { tx, calls };
}
const read = (f: ReturnType<typeof fixture>, projectId: string | null = null, generationId: string | null = "generation") =>
  mcpCallDisplayRedaction(f.tx, identity, generationId, "user", projectId);
const shown = (argumentsValue: unknown, values: readonly string[]) => projectMcpCallDetails({
  id: "call", toolName: "mcp_fixture_read", providerCallId: "provider", state: "complete", arguments: argumentsValue,
  result: { callId: "provider", name: "mcp_fixture_read", status: "complete", content: [{ type: "text", text: "ok" }] },
  values, observation: null, unavailable: false, revision: "revision"
} satisfies McpCallDetailRecord);
afterEach(() => vi.unstubAllEnvs());

describe("MCP display redaction by the secret values known now", () => {
  it("reads the accepted generation's sensitive slots without runtime or external calls", async () => {
    const f = fixture();
    expect(await read(f)).toEqual({ values: ["synthetic-secret"] });
    expect(f.calls.generation).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: "generation", fingerprint: identity.fingerprint, userServer: { userId: "user", serverId: "server" }
    }) }));
    expect(f.calls.connections).not.toHaveBeenCalled();
  });

  it("shows the request after the generation was deleted, redacted by the current shared and personal values", async () => {
    const f = fixture({ generation: null, server: sharedServer("current-shared"), personal: personalServer("current-personal") });
    const redaction = await read(f);
    expect(redaction).toEqual({ values: ["current-shared", "current-personal"] });
    expect(f.calls.personal).toHaveBeenCalledWith(expect.objectContaining({ where: { userId_serverId: { userId: "user", serverId: "server" } } }));
    const details = shown({ query: "q", token: "current-shared", other: "current-personal" }, redaction.values);
    expect(details.requestState).toBe("available");
    expect(details.request?.text).toBe('{\n  "query": "q",\n  "token": "[REDACTED]",\n  "other": "[REDACTED]"\n}');
  });

  it("accepts that a rotated old secret the model put into the arguments stays visible to the initiator", async () => {
    // Operator decision 2026-09-30: the old value is not known any more and
    // cannot be redacted. Only the initiator, who owns it, can read the call.
    const f = fixture({ generation: null, server: sharedServer("rotated-current", 2) });
    const redaction = await read(f);
    expect(redaction).toEqual({ values: ["rotated-current"] });
    const details = shown({ echoed: "synthetic-secret", current: "rotated-current" }, redaction.values);
    expect(details.request?.text).toContain('"echoed": "synthetic-secret"');
    expect(details.request?.text).not.toContain("rotated-current");
  });

  it("uses the current OAuth tokens and client secret after a refresh, whatever their generation", async () => {
    for (const tokenGeneration of [1, 2, 7]) {
      const f = fixture({ revision: { configuration: oauthConfiguration }, generation: null,
        connections: [oauthConnection("oauth", tokenGeneration, `access-${tokenGeneration}`, tokenGeneration)] });
      const redaction = await read(f);
      expect(redaction).toEqual({ values: [`access-${tokenGeneration}`, `access-${tokenGeneration}-refresh`, "synthetic-client"] });
      expect(f.calls.connections).toHaveBeenCalledWith(expect.objectContaining({
        where: { serverId: "server", userId: "user", tokenEnvelope: { not: null } }, take: 4 }));
      const details = shown({ token: `access-${tokenGeneration}` }, redaction.values);
      expect(details.requestState).toBe("available");
      expect(details.request?.text).toBe('{\n  "token": "[REDACTED]"\n}');
    }
  });

  it("adds the accepted generation's own OAuth connection when it is not among the newest", async () => {
    const bound = oauthConnection("bound", 3, "bound-access");
    const f = fixture({ revision: { configuration: oauthConfiguration }, generation: { ...generation, oauthConnection: bound },
      connections: [oauthConnection("newer", 1, "newer-access")] });
    expect((await read(f)).values).toEqual(["newer-access", "newer-access-refresh", "synthetic-client", "bound-access", "bound-access-refresh"]);
  });

  it("shows the request of a removed server with an empty redaction list", async () => {
    const f = fixture({ revision: null, server: null, generation: null });
    const redaction = await read(f);
    expect(redaction).toEqual({ values: [] });
    expect(f.calls.generation).not.toHaveBeenCalled();
    expect(shown({ query: "q" }, redaction.values)).toMatchObject({ requestState: "available", request: { text: '{\n  "query": "q"\n}' } });
  });

  it("uses the values that could be read when an envelope or the key cannot be decrypted", async () => {
    const f = fixture({ generation: { ...generation, effectiveConfigEnvelope: "invalid" }, server: sharedServer("current-shared"),
      personal: { id: "user-server", personalConfigVersion: 0, personalConfigEnvelope: "invalid" } });
    expect(await read(f)).toEqual({ values: ["current-shared"] });
    const oauth = fixture({ revision: { configuration: oauthConfiguration }, generation: null,
      connections: [{ ...oauthConnection("oauth", 2, "access"), tokenEnvelope: "invalid" }] });
    expect(await read(oauth)).toEqual({ values: ["synthetic-client"] });
    const keyless = fixture();
    vi.stubEnv("AIQSA_ENCRYPTION_KEY", "");
    expect(await read(keyless)).toEqual({ values: [] });
    expect(keyless.calls.generation).not.toHaveBeenCalled();
  });

  it("reads a Project call from shared values only, never personal values or OAuth", async () => {
    const f = fixture({ server: sharedServer("current-shared") });
    expect(await read(f, "project")).toEqual({ values: ["synthetic-secret", "current-shared"] });
    expect(f.calls.generation).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ sharedServerId: "server" }) }));
    expect(f.calls.personal).not.toHaveBeenCalled();
    const oauth = fixture({ revision: { configuration: oauthConfiguration } });
    expect(await read(oauth, "project")).toEqual({ values: [] });
    expect(oauth.calls.connections).not.toHaveBeenCalled();
  });

  it("does not look up secret context for a server without sensitive slots or OAuth", async () => {
    const f = fixture({ revision: { configuration: { ...configuration, auth: { mode: "none" }, slots: [] } } });
    expect(await read(f, null, null)).toEqual({ values: [] });
    expect(f.calls.generation).not.toHaveBeenCalled();
    expect(f.calls.personal).not.toHaveBeenCalled();
  });
});
