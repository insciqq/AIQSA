// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { decodeResourceChangeCard } from "@/lib/contracts/resourceChanges";
import { SELF_SERVICE_TOOL_NAMES } from "../engine/prompts/selfService";
import { toolActivityDescriptors } from "./activityDescriptors";
import { SELF_SERVICE_TOOLS, executeSelfServiceTool, type SelfServiceRunDeps } from "./selfServiceTools";
import type { ToolExecutionResult } from "./types";

const USER = "user_1";
const SECRET_ID = "10000000-0000-4000-8000-000000000001";
const VERSION_ID = "20000000-0000-4000-8000-000000000001";
const store = { claim: vi.fn(async () => ({ kind: "open" as const })), settle: vi.fn(async () => undefined) };
const json = (result: ToolExecutionResult | null | undefined) => (result?.content[0] as { value: Record<string, unknown> }).value;

function deps(): SelfServiceRunDeps {
  const db = {
    $transaction: vi.fn(),
    assistantDefinition: { count: vi.fn(async () => 0) },
    attachment: { findFirst: vi.fn(async () => null) },
    skillDefinition: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    user: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => where.id === USER ? { id: USER } : null) },
    workspaceSecret: { findMany: vi.fn(async ({ where }: { where: { userId: string } }) => where.userId === USER ? [{ id: SECRET_ID,
      value: { description: "", envNames: [], id: VERSION_ID, kind: "text", name: "GitLab" } }] : []) }
  };
  return {
    assistants: { deletion: { loadConsequences: vi.fn(async () => null) }, loadCatalogData: vi.fn(async () => null), repository: {
      getDetail: vi.fn(async () => null), listForUser: vi.fn(async () => []), listPublishableGroups: vi.fn(async () => []),
      loadUserAccessibleMcpServerIds: vi.fn(async () => new Set<string>()), loadUserMcpRunPlanView: vi.fn() } as never },
    db: db as never,
    request: { skills: undefined },
    run: { chatId: "chat_1", runId: "run_1", userId: USER },
    secretSource: { list: vi.fn(async () => []), read: vi.fn() }
  };
}

const call = (name: string, args: Record<string, unknown>) => ({ arguments: args, id: `call_${name}`, name });

describe("self-service tools", () => {
  it("are the tools the prompt names, none of which needs approval or the VM", () => {
    expect(SELF_SERVICE_TOOLS.map((tool) => tool.name)).toEqual([SELF_SERVICE_TOOL_NAMES.guide, SELF_SERVICE_TOOL_NAMES.secrets,
      SELF_SERVICE_TOOL_NAMES.skills, SELF_SERVICE_TOOL_NAMES.assistants]);
    for (const tool of SELF_SERVICE_TOOLS) {
      expect(tool).toMatchObject({ needsApproval: false, requiresVm: false });
      expect(tool.tool.name).toBe(tool.name);
      expect(tool.tool.description).toBe(tool.description);
      expect(toolActivityDescriptors({}).get(tool.name)).toMatchObject({ origin: "session", toolName: tool.name });
    }
    expect(SELF_SERVICE_TOOLS.find((tool) => tool.name === "read_aiqsa_guide")?.effects).toBe("none");
    expect(SELF_SERVICE_TOOLS.filter((tool) => tool.effects === "local").map((tool) => tool.name))
      .toEqual(["manage_secret", "manage_skill", "manage_assistant"]);
  });

  it("route a call to its tool with services built for that call, and leave other tools alone", async () => {
    const run = deps();
    expect(executeSelfServiceTool(run, call("save_skill", {}), { callId: "c1", store })).toBeNull();
    expect((await executeSelfServiceTool(run, call("read_aiqsa_guide", { topic: "studio" }), { callId: "c1", store }))?.status).toBe("complete");
    const proposal = await executeSelfServiceTool(run, call("manage_secret", { action: "propose_delete", name: "gitlab" }), { callId: "c2", store });
    expect(json(proposal)).toMatchObject({ deletionProposed: true, secret: { name: "GitLab" } });
    expect(decodeResourceChangeCard((proposal?.artifacts?.[0] as { data: { payload: unknown } }).data.payload))
      .toMatchObject({ action: "delete_proposed", secretId: SECRET_ID, versionId: VERSION_ID });
    expect(run.db.workspaceSecret.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: USER } }));
    const skill = await executeSelfServiceTool(run, call("manage_skill", { action: "propose_delete", target: "skill-hidden" }), { callId: "c3", store });
    expect(json(skill)).toMatchObject({ code: "skill_not_available" });
    const assistants = await executeSelfServiceTool(run, call("manage_assistant", { action: "list" }), { callId: "c4", store });
    expect(json(assistants)).toMatchObject({ assistants: [] });
    expect(store.settle).not.toHaveBeenCalled();
  });
});
