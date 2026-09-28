import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import type { AssistantListingStatus, AssistantListingStatusResponse } from "../../../lib/contracts/assistantListing";
import type {
  AssistantAvatarPalette,
  AssistantAvatarRecipe,
  AssistantAvatarShape,
  AssistantCategory,
  AssistantDetailResponse,
  AssistantPublicationResponse,
  AssistantRows
} from "../../../lib/contracts/assistants";
import type { ChatAssistantUpdate } from "../../../lib/contracts/chats";
import { storedColumnsFromAssistantRows } from "../../../lib/server/assistants/storedContent";

/**
 * Assistants for browser specs. Definitions are created through the API with
 * the rows draft (`create`), or through Prisma with the stored columns
 * (`seed`) when the API would refuse the combination for that owner or the
 * state must be exact. Names carry the fixture's suffix. `cleanup` removes
 * what the fixture created or was told to `track`, never anything else.
 * Creation flows that a scenario is about belong in the scenario, not here.
 */

/** Fixed, valid generated avatar; pass other palettes/shapes to tell cards apart. */
export function e2eAssistantAvatar(
  paletteId: AssistantAvatarPalette = "ocean",
  foregroundShape: AssistantAvatarShape = "diamond"
): AssistantAvatarRecipe {
  return {
    accents: [0, 2],
    backgroundShape: "circle",
    foregroundShape,
    kind: "generated",
    paletteId,
    recipeVersion: 1,
    rotations: [0, 1]
  };
}

/** The seeded deterministic Fake QSA model, usable by every full-access member. */
export async function fakeModelId(prisma: PrismaClient): Promise<string> {
  const model = await prisma.providerModel.findUniqueOrThrow({
    select: { id: true },
    where: { templateKey: "fake:fake-qsa" }
  });
  return model.id;
}

/**
 * Six rows with the product's defaults for a new Assistant (fixed model,
 * adjustable empty controls, fixed Off/None for the resource rows, Skills
 * auto without links), with the given rows replaced whole.
 */
export function e2eAssistantRows(modelId: string, rows: Partial<AssistantRows> = {}): AssistantRows {
  return {
    controls: { policy: "adjustable", value: {} },
    knowledge: { policy: "fixed", value: { mode: "none" } },
    model: { policy: "fixed", value: { mode: "model", modelId } },
    search: { policy: "fixed", value: { mode: "off" } },
    skills: { policy: "fixed", value: { links: [], mode: "auto" } },
    tools: { policy: "fixed", value: { mode: "off" } },
    ...rows
  };
}

export type E2EAssistantInput = Readonly<{
  answerRules?: string | null;
  avatar?: AssistantAvatarRecipe;
  category?: AssistantCategory | null;
  description?: string;
  /** Base name; the fixture appends its suffix. */
  name: string;
  responseReminder?: string;
  /** Rows replaced whole over `e2eAssistantRows` with the Fake QSA model. */
  rows?: Partial<AssistantRows>;
  starterPrompts?: readonly string[];
  systemPrompt?: string;
}>;

export type E2EAssistant = Readonly<{ id: string; name: string; version: number }>;

export type E2EPublicationTarget = Readonly<{ groupId: string }> | "installation";

export type E2EListingRequestSeed = Readonly<{
  assistantId: string;
  /** Pending by default; decided states need a reviewer and go through `decideListing`. */
  state?: "pending" | "superseded" | "withdrawn";
  /** Advances the definition version after the request, as an edit would. */
  outdated?: boolean;
}>;

export type AssistantFixture = Readonly<{
  /** Archives or restores through the owner's API. Returns the new version. */
  archive(owner: APIRequestContext, assistantId: string, archived?: boolean): Promise<number>;
  /** Sets or clears a chat's Assistant and per-chat values through `PATCH /api/chats/[chatId]`. */
  bindChat(request: APIRequestContext, chatId: string, update: ChatAssistantUpdate): Promise<void>;
  /**
   * Removes, for the fixture's records only and in the order the restrictive
   * keys require: its chats, its listing requests and publications, then for
   * every tracked Assistant its listing requests, publications, Project
   * bindings, Skill links and the definition. Idempotent.
   */
  cleanup(): Promise<void>;
  /** Creates through `POST /api/me/assistants` as the signed-in owner of `owner`. */
  create(owner: APIRequestContext, input: E2EAssistantInput): Promise<E2EAssistant>;
  /** Creates an ordinary personal chat, optionally bound; the fixture deletes it on cleanup. */
  createChat(request: APIRequestContext, options?: Readonly<{ assistant?: ChatAssistantUpdate; title?: string }>): Promise<string>;
  /** Approves or rejects a listing request as an administrator. */
  decideListing(admin: APIRequestContext, requestId: string, action: "approve" | "reject", note?: string): Promise<void>;
  /** Places a listed Assistant among Featured (0 first), or removes it with null. */
  feature(admin: APIRequestContext, assistantId: string, order: number | null): Promise<void>;
  /** Pins or unpins for the signed-in viewer. A pin goes with its Assistant or its user. */
  pin(viewer: APIRequestContext, assistantId: string, pinned?: boolean): Promise<void>;
  /** Publishes through the owner's API: a group the owner belongs to, or the installation for an administrator owner. */
  publish(owner: APIRequestContext, assistantId: string, target: E2EPublicationTarget): Promise<string>;
  /** Deletes through the owner's API, as the product does; the fixture stops tracking it. */
  remove(owner: APIRequestContext, assistantId: string): Promise<void>;
  /** Requests listing for everyone at the current version as the (non-administrator) owner. */
  requestListing(owner: APIRequestContext, assistantId: string): Promise<{ listing: AssistantListingStatus; requestId: string }>;
  /**
   * Replaces the content through `PATCH /api/me/assistants/[id]` at the
   * current version, as another session of the owner would. Returns the new version.
   */
  revise(owner: APIRequestContext, assistantId: string, input: E2EAssistantInput): Promise<number>;
  /** Inserts a definition with the stored columns of `rows`, bypassing catalog checks. */
  seed(ownerUserId: string, input: E2EAssistantInput): Promise<E2EAssistant>;
  /** Inserts a listing request at the definition's current version. */
  seedListingRequest(seed: E2EListingRequestSeed): Promise<string>;
  /** Inserts a publication without the owner's membership or administrator checks. */
  seedPublication(assistantId: string, target: E2EPublicationTarget): Promise<string>;
  suffix: string;
  /** Adopts an Assistant a scenario created through the interface, so cleanup removes it. */
  track(assistantId: string): void;
}>;

/** Listing requests, publications, Project bindings, Skill links, then the definitions. */
export async function deleteAssistantRows(tx: Prisma.TransactionClient, assistantIds: readonly string[]): Promise<void> {
  if (assistantIds.length === 0) return;
  const where = { assistantId: { in: [...assistantIds] } };
  await tx.assistantListingRequest.deleteMany({ where });
  await tx.assistantPublication.deleteMany({ where });
  await tx.projectAssistantBinding.deleteMany({ where });
  await tx.assistantSkill.deleteMany({ where });
  await tx.assistantDefinition.deleteMany({ where: { id: { in: [...assistantIds] } } });
}

async function expectStatus(response: APIResponse, status: number): Promise<void> {
  expect(response.status(), await response.text()).toBe(status);
}

async function assistantVersion(request: APIRequestContext, assistantId: string): Promise<number> {
  const response = await request.get(`/api/me/assistants/${assistantId}`);
  await expectStatus(response, 200);
  const { assistant } = await response.json() as AssistantDetailResponse;
  if (assistant.version === undefined) throw new Error("e2e_assistant_version_missing");
  return assistant.version;
}

export function createAssistantFixture(
  prisma: PrismaClient,
  options: Readonly<{ suffix?: string }> = {}
): AssistantFixture {
  const suffix = options.suffix ?? randomUUID().slice(0, 8);
  const assistantIds = new Set<string>();
  const publicationIds = new Set<string>();
  const requestIds = new Set<string>();
  const chatIds = new Set<string>();
  let modelId: string | null = null;

  async function draft(input: E2EAssistantInput) {
    modelId ??= await fakeModelId(prisma);
    return {
      answerRules: input.answerRules ?? null,
      avatar: input.avatar ?? e2eAssistantAvatar(),
      category: input.category ?? null,
      description: input.description ?? "",
      name: `${input.name} ${suffix}`,
      responseReminder: input.responseReminder ?? "",
      rows: e2eAssistantRows(modelId, input.rows),
      starterPrompts: [...(input.starterPrompts ?? [])],
      systemPrompt: input.systemPrompt ?? "You are terse."
    };
  }

  async function bindChat(request: APIRequestContext, chatId: string, update: ChatAssistantUpdate) {
    await expectStatus(await request.patch(`/api/chats/${chatId}`, { data: update }), 200);
  }

  return {
    async archive(owner, assistantId, archived = true) {
      const response = await owner.patch(`/api/me/assistants/${assistantId}`, {
        data: { archived, expectedVersion: await assistantVersion(owner, assistantId) }
      });
      await expectStatus(response, 200);
      const { assistant } = await response.json() as AssistantDetailResponse;
      return assistant.version ?? 0;
    },
    bindChat,
    async cleanup() {
      const chats = [...chatIds];
      const assistants = [...assistantIds];
      const publications = [...publicationIds];
      const requests = [...requestIds];
      chatIds.clear();
      assistantIds.clear();
      publicationIds.clear();
      requestIds.clear();
      if (chats.length + assistants.length + publications.length + requests.length === 0) return;
      await prisma.$transaction(async (tx) => {
        await tx.chat.deleteMany({ where: { id: { in: chats } } });
        await tx.assistantListingRequest.deleteMany({ where: { id: { in: requests } } });
        await tx.assistantPublication.deleteMany({ where: { id: { in: publications } } });
        await deleteAssistantRows(tx, assistants);
      }, { timeout: 30_000 });
    },
    async create(owner, input) {
      const response = await owner.post("/api/me/assistants", { data: await draft(input) });
      await expectStatus(response, 201);
      const { assistant } = await response.json() as AssistantDetailResponse;
      assistantIds.add(assistant.id);
      return { id: assistant.id, name: assistant.content.name, version: assistant.version ?? 1 };
    },
    async createChat(request, chatOptions = {}) {
      const response = await request.post("/api/chats", { data: { title: chatOptions.title ?? `E2E chat ${suffix}` } });
      await expectStatus(response, 201);
      const { chat } = await response.json() as { chat: { id: string } };
      chatIds.add(chat.id);
      if (chatOptions.assistant) await bindChat(request, chat.id, chatOptions.assistant);
      return chat.id;
    },
    async decideListing(admin, requestId, action, note) {
      const response = await admin.post(`/api/admin/assistant-listing-requests/${requestId}/decision`, {
        data: note === undefined ? { action } : { action, note }
      });
      await expectStatus(response, 200);
    },
    async feature(admin, assistantId, order) {
      await expectStatus(await admin.post(`/api/admin/assistants/${assistantId}/featured`, { data: { order } }), 200);
    },
    async pin(viewer, assistantId, pinned = true) {
      const path = `/api/me/assistants/${assistantId}/pin`;
      await expectStatus(await (pinned ? viewer.put(path) : viewer.delete(path)), 204);
    },
    async publish(owner, assistantId, target) {
      const response = await owner.post(`/api/me/assistants/${assistantId}/publications`, {
        data: target === "installation" ? { scope: "installation" } : { groupId: target.groupId, scope: "group" }
      });
      await expectStatus(response, 200);
      const { publication } = await response.json() as AssistantPublicationResponse;
      publicationIds.add(publication.id);
      return publication.id;
    },
    async remove(owner, assistantId) {
      const response = await owner.delete(`/api/me/assistants/${assistantId}`, {
        data: { expectedVersion: await assistantVersion(owner, assistantId) }
      });
      await expectStatus(response, 204);
      assistantIds.delete(assistantId);
    },
    async requestListing(owner, assistantId) {
      const response = await owner.post(`/api/me/assistants/${assistantId}/listing-requests`, {
        data: { expectedVersion: await assistantVersion(owner, assistantId) }
      });
      await expectStatus(response, 200);
      const { listing } = await response.json() as AssistantListingStatusResponse;
      if (!listing.request) throw new Error("e2e_listing_request_missing");
      requestIds.add(listing.request.id);
      return { listing, requestId: listing.request.id };
    },
    async revise(owner, assistantId, input) {
      const response = await owner.patch(`/api/me/assistants/${assistantId}`, {
        data: { content: await draft(input), expectedVersion: await assistantVersion(owner, assistantId) }
      });
      await expectStatus(response, 200);
      const { assistant } = await response.json() as AssistantDetailResponse;
      if (assistant.version === undefined) throw new Error("e2e_assistant_version_missing");
      return assistant.version;
    },
    async seed(ownerUserId, input) {
      const content = await draft(input);
      const { skillLinks, ...columns } = storedColumnsFromAssistantRows(content.rows);
      const id = randomUUID();
      assistantIds.add(id);
      const created = await prisma.$transaction(async (tx) => {
        await tx.assistantDefinition.create({
          data: {
            ...columns,
            answerRules: content.answerRules,
            avatar: content.avatar as unknown as Prisma.InputJsonValue,
            category: content.category,
            description: content.description,
            id,
            knowledgeSelection: columns.knowledgeSelection as unknown as Prisma.InputJsonValue,
            name: content.name,
            ownerUserId,
            responseReminder: content.responseReminder,
            runControls: columns.runControls as Prisma.InputJsonValue,
            searchPlan: columns.searchPlan as Prisma.InputJsonValue,
            starterPrompts: content.starterPrompts,
            systemPrompt: content.systemPrompt
          }
        });
        if (skillLinks.length > 0) {
          await tx.assistantSkill.createMany({
            data: skillLinks.map((link, ordinal) => ({ assistantId: id, mode: link.mode, ordinal, skillId: link.skillId }))
          });
        }
        // Skill links advance the version, so read it last.
        return tx.assistantDefinition.findUniqueOrThrow({ select: { name: true, version: true }, where: { id } });
      });
      return { id, name: created.name, version: created.version };
    },
    async seedListingRequest(seed) {
      const definition = await prisma.assistantDefinition.findUniqueOrThrow({
        select: { ownerUserId: true, version: true },
        where: { id: seed.assistantId }
      });
      const request = await prisma.assistantListingRequest.create({
        data: {
          assistantId: seed.assistantId,
          definitionVersion: definition.version,
          requestedByUserId: definition.ownerUserId,
          state: seed.state ?? "pending"
        },
        select: { id: true }
      });
      requestIds.add(request.id);
      if (seed.outdated) {
        // A pure version step: the version trigger ignores it and content stays as it was.
        await prisma.$executeRaw`
          UPDATE "AssistantDefinition" SET "version" = "version" + 1 WHERE "id" = ${seed.assistantId}
        `;
      }
      return request.id;
    },
    async seedPublication(assistantId, target) {
      const definition = await prisma.assistantDefinition.findUniqueOrThrow({
        select: { ownerUserId: true },
        where: { id: assistantId }
      });
      const publication = await prisma.assistantPublication.create({
        data: target === "installation"
          ? { assistantId, publishedByUserId: definition.ownerUserId, scope: "installation" }
          : { assistantId, groupId: target.groupId, publishedByUserId: definition.ownerUserId, scope: "group" },
        select: { id: true }
      });
      publicationIds.add(publication.id);
      return publication.id;
    },
    suffix,
    track(assistantId) {
      assistantIds.add(assistantId);
    }
  };
}
