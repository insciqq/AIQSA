// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeSubagentDefinitionListResponse, decodeSubagentDefinitionResponse, type SubagentModelOption } from "@/lib/contracts/subagentDefinitions";
import { MemorySubagentDefinitionStore, immediateTransactionDb } from "@/tests/support/subagentDefinitionStore";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { createSubagentDefinitionHandlers } from "./definitionHandlers";
import { createSubagentDefinitionService, type SubagentDefinitionDb } from "./definitionService";

const MODELS: SubagentModelOption[] = [{ connectionName: "Codex LB", defaultEffort: null, displayName: "Cheap Model", efforts: ["low"], modelId: "model-cheap" }];

function session(userId: string, status = "active", role = "user"): AuthenticatedSession {
  return { expiresAt: new Date("2030-01-01"), id: `session-${userId}`, user: { displayName: userId, email: null, id: userId, role, status }, userId };
}

function setup() {
  const memory = new MemorySubagentDefinitionStore();
  const service = createSubagentDefinitionService({ db: immediateTransactionDb<SubagentDefinitionDb>(), models: async () => MODELS, store: memory.store });
  const sessions = new Map<string, AuthenticatedSession>([
    ["a", session("user-a")], ["admin", session("user-admin", "active", "admin")], ["off", session("user-off", "disabled")]
  ]);
  const handlers = createSubagentDefinitionHandlers({ resolveAuth: async (request) => sessions.get(request.headers.get("x-test-user") ?? "") ?? null,
    service });
  const request = (who: string | null, method = "GET", body?: unknown) => new Request("http://aiqsa.test/api/me/subagents", {
    body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", ...(who ? { "x-test-user": who } : {}) }, method
  });
  const params = (definitionId: string) => ({ params: Promise.resolve({ definitionId }) });
  return { handlers, memory, params, request };
}

const DRAFT = { description: "Long browsing.", effort: "low", instructions: "Browse.", modelId: "model-cheap", name: "browser", tools: null };

async function create(context: ReturnType<typeof setup>): Promise<string> {
  const response = await context.handlers.POST(context.request("a", "POST", DRAFT));
  expect(response.status).toBe(201);
  const decoded = decodeSubagentDefinitionResponse(await response.json());
  if (!decoded) throw new Error("undecodable");
  return decoded.definition.id;
}

describe("custom sub-agent routes", () => {
  it("serve the owner a decodable list, detail, edit, restore and delete", async () => {
    const context = setup();
    const { handlers, params, request } = context;
    const id = await create(context);
    const list = await handlers.GET(request("a"));
    expect(list.headers.get("cache-control")).toBe("private, no-store");
    expect(decodeSubagentDefinitionListResponse(await list.json())?.definitions.map((entry) => entry.id)).toEqual([id]);
    const detail = decodeSubagentDefinitionResponse(await (await handlers.detailGET(request("a"), params(id))).json());
    expect(detail?.definition).toMatchObject({ instructions: "Browse.", version: 1 });
    const patched = await handlers.detailPATCH(request("a", "PATCH", { draft: { ...DRAFT, instructions: "Browse more." }, expectedVersion: 1 }), params(id));
    const edited = decodeSubagentDefinitionResponse(await patched.json());
    expect(edited?.definition).toMatchObject({ instructions: "Browse more.", version: 2 });
    const restored = await handlers.restorePOST(request("a", "POST", { expectedVersion: 2, revisionId: edited!.definition.previousRevisionId }), params(id));
    expect(decodeSubagentDefinitionResponse(await restored.json())?.definition).toMatchObject({ instructions: "Browse.", version: 3 });
    expect((await handlers.detailDELETE(request("a", "DELETE", { expectedVersion: 2 }), params(id))).status).toBe(409);
    expect((await handlers.detailDELETE(request("a", "DELETE", { expectedVersion: 3 }), params(id))).status).toBe(204);
    expect(context.memory.rows.size).toBe(0);
  });

  it("answer another user, administrators included, exactly like a missing definition", async () => {
    const context = setup();
    const { handlers, params, request } = context;
    const id = await create(context);
    const missing = "def_missing";
    for (const [method, run] of [
      ["GET", (target: string) => handlers.detailGET(request("admin"), params(target))],
      ["PATCH", (target: string) => handlers.detailPATCH(request("admin", "PATCH", { draft: DRAFT, expectedVersion: 1 }), params(target))],
      ["DELETE", (target: string) => handlers.detailDELETE(request("admin", "DELETE", { expectedVersion: 1 }), params(target))],
      ["POST", (target: string) => handlers.restorePOST(request("admin", "POST", { expectedVersion: 1, revisionId: "rev_1" }), params(target))]
    ] as const) {
      const foreign = await run(id);
      const absent = await run(missing);
      expect([method, foreign.status]).toEqual([method, 404]);
      expect(await foreign.json()).toEqual(await absent.json());
    }
    expect(decodeSubagentDefinitionListResponse(await (await handlers.GET(request("admin"))).json())?.definitions).toEqual([]);
    expect(context.memory.rows.get(id)).toMatchObject({ version: 1 });
  });

  it("refuse unauthenticated and inactive callers before reading anything", async () => {
    const { handlers, params, request } = setup();
    expect((await handlers.GET(request(null))).status).toBe(401);
    expect((await handlers.POST(request(null, "POST", DRAFT))).status).toBe(401);
    expect((await handlers.detailGET(request("off"), params("x"))).status).toBe(403);
  });

  it("bound and decode input with stable codes", async () => {
    const context = setup();
    const { handlers, params, request } = context;
    const invalid = await handlers.POST(request("a", "POST", { ...DRAFT, description: "" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "subagent_definition_invalid", field: "description" });
    const model = await handlers.POST(request("a", "POST", { ...DRAFT, modelId: "other" }));
    expect(await model.json()).toEqual({ error: "subagent_model_unavailable", field: "model" });
    await create(context);
    const duplicate = await handlers.POST(request("a", "POST", DRAFT));
    expect([duplicate.status, await duplicate.json()]).toEqual([409, { error: "subagent_definition_exists" }]);
    expect((await handlers.detailGET(request("a"), params("../etc"))).status).toBe(404);
    expect((await handlers.detailPATCH(request("a", "PATCH", { draft: DRAFT }), params("def_1"))).status).toBe(400);
  });
});
