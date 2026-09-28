import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AssistantRows } from "../../contracts/assistants";
import type { CatalogWireModel } from "../../contracts/catalog";
import { createAssistantListingService, loadAssistantListingStatus, reviewRowsFor, type ListingReviewer } from "./listingRequests";

type Definition = { id: string; ownerUserId: string; version: number; archivedAt: Date | null };
type Pending = { id: string; definitionVersion: number; createdAt: Date } | null;

function fixture(input: { role?: string; definition?: Partial<Definition>; pending?: Pending; listed?: number;
  links?: Array<{ skillId: string; name: string }>; reachable?: string[] } = {}) {
  const definition: Definition = { id: "assistant", ownerUserId: "owner", version: 2, archivedAt: null, ...input.definition };
  const reachable = new Set(input.reachable ?? []);
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray | Prisma.Sql) => {
      const text = "strings" in strings ? strings.strings.join("?") : strings.join("?");
      if (text.includes("\"AssistantDefinition\"")) return [definition];
      if (text.includes("\"SkillDefinition\"")) return (strings as Prisma.Sql).values.map((id) => ({ id }));
      if (text.includes("\"role\" = 'admin'")) return input.role === "admin" ? [{ id: "admin" }] : [];
      return [{ role: input.role ?? "user" }];
    }),
    assistantPublication: { count: vi.fn(async () => input.listed ?? 0), findFirst: vi.fn(async () => null), create: vi.fn() },
    assistantSkill: { findMany: vi.fn(async () => (input.links ?? []).map((link) => ({ skillId: link.skillId,
      skill: { ownerUserId: "owner", currentRevision: { name: link.name }, sharedRevision: null } }))) },
    skillDefinition: { count: vi.fn(async (args: { where: { id: { in: string[] } } }) => args.where.id.in.filter((id) => reachable.has(id)).length) },
    assistantListingRequest: {
      findFirst: vi.fn(async (args: { where: { state?: string } }) => args.where.state === "pending"
        ? input.pending ?? null
        : { createdAt: new Date("2100-01-01T00:00:00.000Z") }),
      findUnique: vi.fn(async () => ({ assistantId: "assistant", state: "pending" })),
      findUniqueOrThrow: vi.fn(async () => ({ id: "request", assistantId: "assistant", state: "approved", definitionVersion: 2,
        createdAt: new Date(), reviewedAt: new Date(), reviewNote: null,
        assistant: { name: "Reviewer", avatar: {}, updatedAt: new Date(), version: 2, archivedAt: null, owner: { displayName: "Owner" } } })),
      updateMany: vi.fn(async () => ({ count: 1 })), create: vi.fn()
    }
  };
  const service = createAssistantListingService({ $transaction: (write: (client: unknown) => unknown) => write(tx) } as unknown as PrismaClient);
  return { tx, service };
}

describe("Assistant listing requests", () => {
  it("supersedes an older pending request and keeps the latest request visible after a clock jump", async () => {
    const f = fixture({ pending: { id: "old", definitionVersion: 1, createdAt: new Date() } });
    await f.service.request("owner", "assistant", 2);
    expect(f.tx.assistantListingRequest.updateMany).toHaveBeenCalledWith({ where: { assistantId: "assistant", state: "pending" }, data: { state: "superseded" } });
    expect(f.tx.assistantListingRequest.create).toHaveBeenCalledWith({ data: { assistantId: "assistant", requestedByUserId: "owner",
      definitionVersion: 2, createdAt: new Date("2100-01-01T00:00:00.001Z") } });
  });

  it("reuses the open request after a lost response at the same version", async () => {
    const f = fixture({ pending: { id: "open", definitionVersion: 2, createdAt: new Date() } });
    await f.service.request("owner", "assistant", 2);
    expect(f.tx.assistantListingRequest.updateMany).not.toHaveBeenCalled();
    expect(f.tx.assistantListingRequest.create).not.toHaveBeenCalled();
  });

  it.each([
    ["assistant_not_available", { definition: { ownerUserId: "other" } }, 2],
    ["assistant_listing_request_not_needed", { role: "admin" }, 2],
    ["assistant_archived", { definition: { archivedAt: new Date() } }, 2],
    ["assistant_version_conflict", {}, 1],
    ["assistant_already_listed", { listed: 1 }, 2]
  ] as const)("refuses %s before writing a request", async (code, options, expectedVersion) => {
    const f = fixture(options);
    await expect(f.service.request("owner", "assistant", expectedVersion)).rejects.toMatchObject({ code });
    expect(f.tx.assistantListingRequest.updateMany).not.toHaveBeenCalled();
    expect(f.tx.assistantListingRequest.create).not.toHaveBeenCalled();
  });

  it("names every linked Skill that does not already reach everyone", async () => {
    const f = fixture({ links: [{ skillId: "listed", name: "Listed" }, { skillId: "private", name: "Private draft" }], reachable: ["listed"] });
    await expect(f.service.request("owner", "assistant", 2)).rejects.toMatchObject({
      code: "assistant_skill_audience_mismatch", status: 409, skillNames: ["Private draft"] });
    expect(f.tx.assistantListingRequest.create).not.toHaveBeenCalled();
  });

  it("refuses to decide a request whose definition changed after it was made", async () => {
    const f = fixture({ role: "admin", definition: { version: 3 }, pending: { id: "request", definitionVersion: 2, createdAt: new Date() } });
    for (const action of ["approve", "reject"] as const) {
      await expect(f.service.decide("admin", "request", action, null)).rejects.toMatchObject({ code: "assistant_listing_request_outdated" });
    }
    expect(f.tx.assistantPublication.create).not.toHaveBeenCalled();
    expect(f.tx.assistantListingRequest.updateMany).not.toHaveBeenCalled();
  });

  it("publishes to everyone and freezes the request in one approval", async () => {
    const f = fixture({ role: "admin", pending: { id: "request", definitionVersion: 2, createdAt: new Date() } });
    const result = await f.service.decide("admin", "request", "approve", "Looks good");
    expect(f.tx.assistantPublication.create).toHaveBeenCalledWith({ data: { assistantId: "assistant", scope: "installation", groupId: null, publishedByUserId: "admin" } });
    expect(f.tx.assistantListingRequest.updateMany).toHaveBeenCalledWith({ where: { id: "request", state: "pending" },
      data: expect.objectContaining({ state: "approved", reviewedByUserId: "admin", reviewNote: "Looks good" }) });
    expect(result).toMatchObject({ state: "approved", outdated: false, canReview: false, assistantId: "assistant" });
  });

  it("rechecks the administrator inside the decision transaction", async () => {
    const f = fixture({ role: "user", pending: { id: "request", definitionVersion: 2, createdAt: new Date() } });
    await expect(f.service.decide("admin", "request", "approve", null)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(f.tx.assistantListingRequest.findUnique).not.toHaveBeenCalled();
  });

  it("reports a withdrawal of a decided request as a conflict", async () => {
    const f = fixture();
    f.tx.assistantListingRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(f.service.withdraw("owner", "assistant", "request")).rejects.toMatchObject({ code: "assistant_listing_request_conflict" });
  });

  it.each([
    { code: "P2034" }, { code: "P2010", meta: { code: "40001" } },
    { code: "P2002", meta: { target: "AssistantListingRequest_pending_assistant_key" } }
  ])("bounds transaction retries and returns 409 after $code collisions", async ({ code, meta }) => {
    const transact = vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError("synthetic", { code, meta, clientVersion: "test" }));
    const service = createAssistantListingService({ $transaction: transact } as unknown as PrismaClient);
    await expect(service.request("owner", "assistant", 2)).rejects.toMatchObject({ code: "assistant_listing_request_conflict", status: 409 });
    expect(transact).toHaveBeenCalledTimes(3);
  });

  it("does not retry an unrelated uniqueness failure", async () => {
    const error = new Prisma.PrismaClientKnownRequestError("synthetic", { code: "P2002", meta: { target: "AssistantPublication_installation_key" }, clientVersion: "test" });
    const transact = vi.fn().mockRejectedValue(error);
    const service = createAssistantListingService({ $transaction: transact } as unknown as PrismaClient);
    await expect(service.request("owner", "assistant", 2)).rejects.toBe(error);
    expect(transact).toHaveBeenCalledTimes(1);
  });
});

describe("Assistant listing owner status", () => {
  const request = (state: string, definitionVersion: number) => ({ id: "request", state, definitionVersion,
    createdAt: new Date("2026-09-27T00:00:00.000Z"), reviewedAt: null, reviewNote: null });
  const load = (row: object | null, input: { isAdmin?: boolean; listed?: boolean; archived?: boolean } = {}) => loadAssistantListingStatus({
    assistantDefinition: { findFirst: vi.fn(async () => row && { version: 3, archivedAt: input.archived ? new Date() : null,
      publications: input.listed ? [{ id: "publication" }] : [], listingRequests: [row] }) }
  } as never, { assistantId: "assistant", userId: "owner", isAdmin: input.isAdmin ?? false });

  it("shows a pending request for an older version as outdated and lets the owner submit again", async () => {
    expect(await load(request("pending", 2))).toEqual({ listed: false, canRequest: true, canWithdraw: true,
      request: { id: "request", state: "pending", definitionVersion: 2, outdated: true, createdAt: "2026-09-27T00:00:00.000Z", reviewedAt: null, reviewNote: null } });
    expect(await load(request("pending", 3))).toMatchObject({ canRequest: false, canWithdraw: true, request: { outdated: false } });
    expect(await load(request("rejected", 2))).toMatchObject({ canRequest: true, canWithdraw: false, request: { outdated: false } });
  });

  it("offers no request to administrators, listed or archived Assistants, and nothing to non-owners", async () => {
    expect(await load(request("rejected", 3), { isAdmin: true })).toMatchObject({ canRequest: false });
    expect(await load(request("approved", 3), { listed: true })).toMatchObject({ canRequest: false, listed: true });
    expect(await load(request("withdrawn", 3), { archived: true })).toMatchObject({ canRequest: false });
    expect(await load(null)).toBeNull();
  });
});

describe("Assistant listing review rows", () => {
  const storedRows: AssistantRows = {
    model: { policy: "fixed", value: { mode: "model", modelId: "owner-model" } },
    controls: { policy: "fixed", value: { reasoningEffort: "high" } },
    search: { policy: "adjustable", value: { mode: "model_choice", optionIds: ["web", "private-search"] } },
    tools: { policy: "fixed", value: { mode: "exact", serverIds: ["shared-mcp", "owner-mcp"] } },
    knowledge: { policy: "fixed", value: { mode: "explicit", baseIds: ["shared-kb", "owner-kb"], sourceIds: ["owner-source"] } },
    skills: { policy: "adjustable", value: { mode: "auto", links: [{ skillId: "listed-skill", delivery: "always" }, { skillId: "draft-skill", delivery: "on_demand" }] } }
  };
  const reviewer = (models: string[] = []): ListingReviewer => ({
    catalog: {
      accessibleMcpServerIds: new Set(["shared-mcp", "admin-mcp"]),
      entitledSearchOptionIds: new Set(["web"]),
      modelById: new Map(models.map((id) => [id, { displayName: `Model ${id}`, modelId: id } as CatalogWireModel]))
    },
    names: {
      knowledgeBases: new Map([["shared-kb", "Company handbook"]]),
      knowledgeSources: new Map(),
      mcpServers: new Map([["shared-mcp", "Docs search"], ["admin-mcp", "Admin tools"]]),
      searchOptions: new Map([["web", "Web"], ["unused", "Unused option"]]),
      skills: new Map([["listed-skill", "Style guide"]])
    },
    visibleKnowledge: { baseIds: ["shared-kb"], sourceIds: [] }
  });

  it("identifies and names only what the administrator can use and counts the rest", () => {
    const review = reviewRowsFor(storedRows, reviewer());
    expect(review.rows).toEqual({
      model: { policy: "fixed", value: { mode: "model", modelId: null } },
      controls: { policy: "fixed", value: { reasoningEffort: "high" } },
      search: { policy: "adjustable", value: { mode: "model_choice", optionIds: ["web"], hiddenCount: 1 } },
      tools: { policy: "fixed", value: { mode: "exact", serverIds: ["shared-mcp"], hiddenCount: 1 } },
      knowledge: { policy: "fixed", value: { mode: "explicit", baseIds: ["shared-kb"], sourceIds: [], hiddenCount: 2 } },
      skills: { policy: "adjustable", value: { mode: "auto", links: [{ skillId: "listed-skill", delivery: "always" }], hiddenCount: 1 } }
    });
    expect(review.names).toEqual({
      knowledgeBases: [{ id: "shared-kb", name: "Company handbook" }], knowledgeSources: [],
      mcpServers: [{ id: "shared-mcp", name: "Docs search" }], models: [],
      searchOptions: [{ id: "web", name: "Web" }], skills: [{ id: "listed-skill", name: "Style guide" }]
    });
    expect(JSON.stringify(review)).not.toMatch(/owner-model|private-search|owner-mcp|owner-kb|owner-source|draft-skill|Admin tools|Unused option/u);
    expect(reviewRowsFor(storedRows, reviewer(["owner-model"])).names.models).toEqual([{ id: "owner-model", name: "Model owner-model" }]);
  });

  it("keeps inherit, Off and None distinct and names nothing for them", () => {
    const review = reviewRowsFor({ ...storedRows,
      model: { policy: "adjustable", value: { mode: "inherit" } },
      controls: { policy: "adjustable", value: {} },
      search: { policy: "adjustable", value: { mode: "inherit" } },
      tools: { policy: "fixed", value: { mode: "off" } },
      knowledge: { policy: "fixed", value: { mode: "none" } },
      skills: { policy: "fixed", value: { mode: "off", links: [] } } }, reviewer(["owner-model"]));
    expect(review.rows).toMatchObject({ model: { value: { mode: "inherit" } }, search: { value: { mode: "inherit" } },
      tools: { value: { mode: "off" } }, knowledge: { value: { mode: "none" } }, skills: { value: { mode: "off", links: [] } } });
    expect(Object.values(review.names).flat()).toEqual([]);
  });
});

describe("Assistant listing request detail", () => {
  const assistantRecord = (version: number, archivedAt: Date | null = null) => ({ name: "Writing editor", avatar: {}, updatedAt: new Date("2026-09-27T00:00:00.000Z"),
    version, archivedAt, owner: { displayName: "Camila" } });
  const definitionRecord = { version: 2, name: "Writing editor", description: "Edits drafts", category: null, avatar: {}, systemPrompt: "Be brief.",
    answerRules: null, responseReminder: "", starterPrompts: ["Tighten this"], modelPolicy: "fixed", controlsPolicy: "adjustable",
    searchPolicy: "fixed", toolsPolicy: "fixed", knowledgePolicy: "fixed", skillsPolicy: "fixed", mcpMode: "off", mcpServerIds: [],
    searchPlan: { mode: "off" }, knowledgeSelection: { mode: "explicit", baseIds: ["owner-kb"], sourceIds: [], version: 1 },
    skillsMode: "auto", providerModelId: "owner-model", runControls: {}, skillLinks: [] };

  function detailFixture(assistant: ReturnType<typeof assistantRecord>) {
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "admin" }]),
      assistantListingRequest: { findFirst: vi.fn(async () => ({ id: "request", assistantId: "assistant", state: "pending", definitionVersion: 2,
        createdAt: new Date("2026-09-27T00:00:00.000Z"), reviewedAt: null, reviewNote: null, assistant })) },
      assistantDefinition: { findUnique: vi.fn(async () => ({ ...definitionRecord, version: assistant.version })) }
    };
    const loadReviewer = vi.fn(async (): Promise<ListingReviewer> => ({
      catalog: { accessibleMcpServerIds: new Set(), entitledSearchOptionIds: new Set(), modelById: new Map() },
      names: { knowledgeBases: new Map(), knowledgeSources: new Map(), mcpServers: new Map(), searchOptions: new Map(), skills: new Map() },
      visibleKnowledge: { baseIds: [], sourceIds: [] }
    }));
    const service = createAssistantListingService({ $transaction: (write: (client: unknown) => unknown) => write(tx) } as unknown as PrismaClient,
      { loadReviewer });
    return { loadReviewer, service, tx };
  }

  it("projects the rows for the administrator as the viewer", async () => {
    const f = detailFixture(assistantRecord(2));
    const detail = await f.service.detail("admin", "request");
    expect(f.loadReviewer).toHaveBeenCalledWith(f.tx, "admin", expect.objectContaining({ knowledge: expect.anything() }));
    expect(detail.definition).toMatchObject({ version: 2, instructions: "Be brief.", rows: {
      model: { policy: "fixed", value: { mode: "model", modelId: null } },
      knowledge: { policy: "fixed", value: { mode: "explicit", baseIds: [], sourceIds: [], hiddenCount: 1 } }
    } });
    expect(JSON.stringify(detail)).not.toMatch(/owner-kb|owner-model/u);
  });

  it.each([["outdated", assistantRecord(3)], ["archived", assistantRecord(2, new Date())]])("returns no definition or rows for an %s request", async (_state, assistant) => {
    const f = detailFixture(assistant);
    await expect(f.service.detail("admin", "request")).resolves.toMatchObject({ canReview: false, definition: null });
    expect(f.tx.assistantDefinition.findUnique).not.toHaveBeenCalled();
    expect(f.loadReviewer).not.toHaveBeenCalled();
  });
});
