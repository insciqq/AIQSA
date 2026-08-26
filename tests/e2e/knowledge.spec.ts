import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { runAccountMenuAction } from "./shell/page";

test.setTimeout(120_000);

const timestamp = "2026-08-08T10:00:00.000Z";
const baseSupportReference = "K-123456ABCDEF";
const fileSupportReference = "K-ABCDEF012345";

type SourceFixture = Readonly<{
  currentVersion: Readonly<{
    byteSize: number;
    createdAt: string;
    fileName: string;
    isCurrent: boolean;
    isPending: boolean;
    pageCount: number | null;
    readiness: Readonly<{
      state: "ready";
      supportReference: null;
      warningCodes: readonly "partial_parse"[];
    }>;
    versionNumber: number;
  }> | null;
  deletionPending: boolean;
  description: string;
  id: string;
  membershipCount: number;
  name: string;
  owned: boolean;
  ownerDisplayName: string;
  purgeScheduledAt: null;
  readiness: Readonly<{
    state: "needs_attention" | "processing" | "ready";
    supportReference: string | null;
    warningCodes: readonly "partial_parse"[];
  }>;
  replacement: Readonly<{ state: "none"; supportReference: null }>;
  tags: readonly string[];
  trashed: false;
  trashedAt: null;
  updatedAt: string;
  version: number;
}>;

type UploadItemFixture = {
  attemptNumber: number;
  byteSize: number;
  clientFileId: string;
  failureCode: string | null;
  fileName: string;
  id: string;
  sourceId: string | null;
  state: "cancelled" | "needs_attention" | "processing" | "queued" | "ready" |
    "ready_with_warnings" | "reused" | "upload_complete" | "uploading";
  transport: { kind: "proxy"; uploadUrl: string } | null;
  updatedAt: string;
  uploadedBytes: number;
};

type UploadBatchFixture = {
  createdAt: string;
  id: string;
  items: UploadItemFixture[];
  updatedAt: string;
};

function uploadedSource(input: {
  byteSize?: number;
  fileName?: string;
  sourceNumber: number;
  state: "needs_attention" | "processing" | "ready";
}): SourceFixture {
  const fileName = input.fileName ?? (input.sourceNumber === 1 ? "handbook.md" : "incident.txt");
  const warningCodes = input.state === "ready" && input.sourceNumber === 1
    ? ["partial_parse" as const]
    : [];
  const readiness = {
    state: input.state,
    supportReference: input.state === "needs_attention" ? fileSupportReference : null,
    warningCodes
  };
  return {
    currentVersion: input.state === "ready" ? {
      byteSize: input.byteSize ?? 24,
      createdAt: timestamp,
      fileName,
      isCurrent: true,
      isPending: false,
      pageCount: null,
      readiness: { state: "ready", supportReference: null, warningCodes },
      versionNumber: 1
    } : null,
    deletionPending: false,
    description: "",
    id: `source-upload-${input.sourceNumber}`,
    membershipCount: 1,
    name: fileName,
    owned: true,
    ownerDisplayName: "E2E operator",
    purgeScheduledAt: null,
    readiness,
    replacement: { state: "none", supportReference: null },
    tags: [],
    trashed: false,
    trashedAt: null,
    updatedAt: timestamp,
    version: 1
  };
}

async function installKnowledgeFixture(page: Page) {
  let created = false;
  let uploadCount = 0;
  let uploadBatches: UploadBatchFixture[] = [];
  const interruptedUploadIds = new Set<string>();
  let archived = false;
  let baseDeletionPending = false;
  let baseTrashed = false;
  let baseVersion = 1;
  let uploadedSources: SourceFixture[] = [];
  let publications: Array<{
    groupId: string | null;
    groupName: string | null;
    id: string;
    scope: "group" | "installation";
    updatedAt: string;
  }> = [];
  const sourceBases = new Map([
    ["base-source-a", "Product docs"],
    ["base-source-b", "Assistant docs"],
    ["base-source-c", "Project docs"]
  ]);
  let sourceMembershipIds = ["base-source-a"];
  let sourceName = "Reusable product guide";
  let sourceDescription = "Canonical guidance shared across Knowledge bases";
  let sourceTags = ["product", "onboarding"];
  let sourceDeletionPending = false;
  let sourceTrashed = false;
  let sourceVersion = 1;

  function readiness() {
    const readySources = uploadedSources.filter((entry) => entry.readiness.state === "ready").length;
    const processingSources = uploadedSources.filter(
      (entry) => entry.readiness.state === "processing"
    ).length;
    const attentionSources = uploadedSources.filter(
      (entry) => entry.readiness.state === "needs_attention"
    ).length;
    const totalSources = uploadedSources.length;
    const state = baseTrashed
      ? "trashed" as const
      : archived
      ? "archived" as const
      : totalSources === 0
        ? "empty" as const
        : attentionSources > 0
          ? "needs_attention" as const
          : processingSources > 0
            ? "processing" as const
            : "ready" as const;
    return {
      attentionSources,
      processingSources,
      readySources,
      state,
      supportReference: state === "needs_attention" ? baseSupportReference : null,
      totalSources
    };
  }

  function summary() {
    return {
      archived,
      deletionPending: baseDeletionPending,
      description: "Operational references",
      sourceCount: uploadedSources.length,
      id: "base-e2e",
      name: "E2E runbooks",
      owned: true,
      ownerDisplayName: "E2E operator",
      purgeScheduledAt: baseTrashed ? "2026-09-07T10:00:00.000Z" : null,
      readiness: readiness(),
      scope: { kind: "owner" as const },
      trashed: baseTrashed,
      trashedAt: baseTrashed ? timestamp : null,
      updatedAt: timestamp,
      version: baseVersion
    };
  }

  function detail() {
    return { ...summary(), publications };
  }

  const currentSourceVersion = {
    byteSize: 2_400,
    createdAt: timestamp,
    fileName: "product-guide.pdf",
    isCurrent: true,
    isPending: false,
    pageCount: 8,
    readiness: {
      state: "ready" as const,
      supportReference: null,
      warningCodes: ["table_extraction_degraded" as const]
    },
    versionNumber: 2
  };

  function sourceDetail() {
    const memberships = sourceMembershipIds.map((id) => ({
      archived: false,
      id,
      name: sourceBases.get(id)!
    }));
    const eligibleBases = [...sourceBases]
      .filter(([id]) => !sourceMembershipIds.includes(id))
      .map(([id, name]) => ({ archived: false, id, name }));
    return {
      currentVersion: currentSourceVersion,
      deletionPending: sourceDeletionPending,
      description: sourceDescription,
      eligibleBases,
      id: "source-e2e",
      membershipCount: memberships.length,
      memberships,
      name: sourceName,
      owned: true,
      ownerDisplayName: "E2E operator",
      purgeScheduledAt: sourceTrashed ? "2026-09-07T10:00:00.000Z" : null,
      readiness: {
        state: "ready" as const,
        supportReference: null,
        warningCodes: ["table_extraction_degraded" as const]
      },
      replacement: { state: "none" as const, supportReference: null },
      tags: sourceTags,
      trashed: sourceTrashed,
      trashedAt: sourceTrashed ? timestamp : null,
      updatedAt: timestamp,
      version: sourceVersion,
      versions: [
        currentSourceVersion,
        {
          ...currentSourceVersion,
          createdAt: "2026-08-07T10:00:00.000Z",
          fileName: "product-guide-v1.pdf",
          isCurrent: false,
          versionNumber: 1
        }
      ]
    };
  }

  function sourceSummary() {
    const { eligibleBases: _eligibleBases, memberships: _memberships, versions: _versions, ...value } = sourceDetail();
    return value;
  }

  function uploadedSourceDetail(value: SourceFixture) {
    const pendingVersion = {
      byteSize: value.currentVersion?.byteSize ?? 24,
      createdAt: timestamp,
      fileName: value.currentVersion?.fileName ?? value.name,
      isCurrent: false,
      isPending: true,
      pageCount: null,
      readiness: value.readiness,
      versionNumber: 1
    };
    return {
      ...value,
      eligibleBases: [],
      memberships: [{ archived: false, id: "base-e2e", name: "E2E runbooks" }],
      versions: value.currentVersion ? [value.currentVersion] : [pendingVersion]
    };
  }

  async function fulfillJson(route: Route, json: unknown, status = 200) {
    await route.fulfill({ json, status });
  }

  await page.route(/\/api\/me\/knowledge-(?:bases|uploads)(?:\/|$)/u, async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;

    if (path === "/api/me/knowledge-bases" && method === "GET") {
      await fulfillJson(route, {
        knowledgeBases: created ? [summary()] : [],
        publishableGroups: [{ id: "group-e2e", name: "Research" }],
        viewer: {
          canCreate: true,
          canPublishInstallation: true,
          maxUploadBytes: 50_000_000
        }
      });
      return;
    }
    if (path === "/api/me/knowledge-bases" && method === "POST") {
      expect(request.postDataJSON()).toEqual({
        description: "Operational references",
        name: "E2E runbooks"
      });
      created = true;
      await fulfillJson(route, { knowledgeBase: detail() }, 201);
      return;
    }
    if (path === "/api/me/knowledge-bases/base-e2e" && method === "GET") {
      await fulfillJson(route, { knowledgeBase: detail() });
      return;
    }
    if (path === "/api/me/knowledge-bases/base-e2e" && method === "PATCH") {
      const body = request.postDataJSON() as { archived?: boolean; expectedVersion?: number };
      expect(body.expectedVersion).toBe(baseVersion);
      if (typeof body.archived === "boolean") archived = body.archived;
      baseVersion += 1;
      await fulfillJson(route, { knowledgeBase: detail() });
      return;
    }
    if (path === "/api/me/knowledge-bases/base-e2e/upload-batches" && method === "GET") {
      await fulfillJson(route, { batches: uploadBatches });
      return;
    }
    if (path === "/api/me/knowledge-bases/base-e2e/upload-batches" && method === "POST") {
      const body = request.postDataJSON() as {
        clientBatchId: string;
        files: Array<{
          byteSize: number;
          clientFileId: string;
          fileName: string;
          mimeType: string;
        }>;
      };
      expect(body.clientBatchId).toMatch(/^batch-/u);
      const batchId = `upload-batch-${uploadBatches.length + 1}`;
      const batch: UploadBatchFixture = {
        createdAt: timestamp,
        id: batchId,
        items: body.files.map((file, index) => ({
          attemptNumber: 1,
          byteSize: file.byteSize,
          clientFileId: file.clientFileId,
          failureCode: null,
          fileName: file.fileName,
          id: `upload-item-${uploadBatches.length + 1}-${index + 1}`,
          sourceId: null,
          state: "queued",
          transport: {
            kind: "proxy",
            uploadUrl: `/api/me/knowledge-uploads/base-e2e/${batchId}/upload-item-${uploadBatches.length + 1}-${index + 1}/content?attempt=1`
          },
          updatedAt: timestamp,
          uploadedBytes: 0
        })),
        updatedAt: timestamp
      };
      uploadBatches = [batch, ...uploadBatches];
      await fulfillJson(route, { batch }, 201);
      return;
    }
    const uploadPath = path.match(
      /^\/api\/me\/knowledge-uploads\/base-e2e\/([^/]+)\/([^/]+)(?:\/(start|content|settle|retry))?$/u
    );
    if (uploadPath) {
      const batch = uploadBatches.find((candidate) => candidate.id === uploadPath[1]);
      const item = batch?.items.find((candidate) => candidate.id === uploadPath[2]);
      if (!batch || !item) {
        await fulfillJson(route, { error: "knowledge_upload_not_available" }, 404);
        return;
      }
      const action = uploadPath[3];
      if (method === "GET" && !action) {
        await fulfillJson(route, { batch });
        return;
      }
      if (method === "DELETE" && !action) {
        expect(request.postDataJSON()).toEqual({ attemptNumber: item.attemptNumber });
        item.state = "cancelled";
        item.transport = null;
        item.uploadedBytes = 0;
        await fulfillJson(route, { batch });
        return;
      }
      if (method === "POST" && action === "start") {
        expect(request.postDataJSON()).toEqual({ attemptNumber: item.attemptNumber });
        item.state = "uploading";
        await fulfillJson(route, { batch });
        return;
      }
      if (method === "PUT" && action === "content") {
        expect(new URL(request.url()).searchParams.get("attempt")).toBe(String(item.attemptNumber));
        expect(request.postDataBuffer()?.byteLength).toBe(item.byteSize);
        if (item.fileName === "file-50.md" && !interruptedUploadIds.has(item.id)) {
          interruptedUploadIds.add(item.id);
          await route.abort("failed");
          return;
        }
        item.state = "upload_complete";
        item.transport = null;
        item.uploadedBytes = item.byteSize;
        await fulfillJson(route, { batch }, 202);
        return;
      }
      if (method === "POST" && action === "settle") {
        expect(request.postDataJSON()).toEqual({ attemptNumber: item.attemptNumber });
        if (!item.sourceId) {
          uploadCount += 1;
          // Proxy uploads settle concurrently. Keep the two-file contract bound
          // to file identity instead of whichever request happens to finish first.
          const sourceNumber = item.fileName === "handbook.md"
            ? 1
            : item.fileName === "incident.txt"
              ? 2
              : uploadCount;
          const state = item.fileName === "incident.txt" ||
            !["handbook.md", "incident.txt"].includes(item.fileName) && uploadCount === 2
            ? "needs_attention"
            : "ready";
          const next = uploadedSource({
            byteSize: item.byteSize,
            fileName: item.fileName,
            sourceNumber,
            state
          });
          uploadedSources = [...uploadedSources, next];
          item.failureCode = state === "needs_attention" ? "knowledge_processing_failed" : null;
          item.sourceId = `source-upload-${sourceNumber}`;
          item.state = state === "needs_attention"
            ? "needs_attention"
            : sourceNumber === 1
              ? "ready_with_warnings"
              : "ready";
        }
        await fulfillJson(route, { batch }, 202);
        return;
      }
      if (method === "POST" && action === "retry") {
        expect(request.postDataJSON()).toEqual({ attemptNumber: item.attemptNumber });
        item.attemptNumber += 1;
        item.failureCode = null;
        item.sourceId = null;
        item.state = "queued";
        item.transport = {
          kind: "proxy",
          uploadUrl: `${path.slice(0, -"/retry".length)}/content?attempt=${item.attemptNumber}`
        };
        item.uploadedBytes = 0;
        await fulfillJson(route, { batch });
        return;
      }
    }
    if (
      path === "/api/me/knowledge-bases/base-e2e/trash" &&
      method === "POST"
    ) {
      expect(request.postDataJSON()).toEqual({ expectedVersion: baseVersion });
      baseTrashed = true;
      baseVersion += 1;
      await route.fulfill({ status: 204 });
      return;
    }
    if (
      path === "/api/me/knowledge-bases/base-e2e/restore" &&
      method === "POST"
    ) {
      expect(request.postDataJSON()).toEqual({ expectedVersion: baseVersion });
      baseTrashed = false;
      baseVersion += 1;
      await route.fulfill({ status: 204 });
      return;
    }
    if (
      path === "/api/me/knowledge-bases/base-e2e/delete-permanently" &&
      method === "POST"
    ) {
      expect(request.postDataJSON()).toEqual({ expectedVersion: baseVersion });
      baseDeletionPending = true;
      baseVersion += 1;
      await fulfillJson(route, { status: "pending" }, 202);
      return;
    }
    if (path === "/api/me/knowledge-bases/base-e2e/publications" && method === "POST") {
      expect(request.postDataJSON()).toEqual({ groupId: "group-e2e", scope: "group" });
      const publication = {
        groupId: "group-e2e",
        groupName: "Research",
        id: "publication-e2e",
        scope: "group" as const,
        updatedAt: timestamp
      };
      publications = [publication];
      await fulfillJson(route, { publication }, 201);
      return;
    }
    if (path.endsWith("/publications/publication-e2e") && method === "DELETE") {
      publications = [];
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({ json: { error: "knowledge_base_not_available" }, status: 404 });
  });

  await page.route("**/api/me/knowledge-sources**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    if (path === "/api/me/knowledge-sources" && method === "GET") {
      const filter = url.searchParams.get("filter") ?? "all";
      const query = (url.searchParams.get("q") ?? "").trim();
      const baseId = url.searchParams.get("baseId");
      if (baseId === "base-e2e") {
        const matching = uploadedSources.filter((source) =>
          [source.name, source.description, source.currentVersion?.fileName ?? "", ...source.tags]
            .some((value) => value.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
        );
        const pageSize = Number(url.searchParams.get("pageSize") ?? "25");
        const totalPages = matching.length > 0 ? Math.ceil(matching.length / pageSize) : 0;
        const requestedPage = Number(url.searchParams.get("page") ?? "1");
        const pageNumber = Math.min(requestedPage, Math.max(1, totalPages));
        await fulfillJson(route, {
          pagination: {
            page: pageNumber,
            pageSize,
            query,
            totalItems: matching.length,
            totalPages
          },
          sources: matching.slice((pageNumber - 1) * pageSize, pageNumber * pageSize)
        });
        return;
      }
      const lifecycleMatches = filter === "trash" ? sourceTrashed : !sourceTrashed;
      const matches = lifecycleMatches && filter !== "shared" &&
        [sourceName, sourceDescription, ...sourceTags]
        .some((value) => value.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      await fulfillJson(route, {
        pagination: {
          page: 1,
          pageSize: 25,
          query,
          totalItems: matches ? 1 : 0,
          totalPages: matches ? 1 : 0
        },
        sources: matches ? [sourceSummary()] : []
      });
      return;
    }
    const uploadedSourceMatch = path.match(/^\/api\/me\/knowledge-sources\/(source-upload-\d+)$/u);
    if (uploadedSourceMatch && method === "GET") {
      const value = uploadedSources.find((source) => source.id === uploadedSourceMatch[1]);
      await fulfillJson(route, value
        ? { source: uploadedSourceDetail(value) }
        : { error: "knowledge_source_not_available" }, value ? 200 : 404);
      return;
    }
    const uploadedReprocessMatch = path.match(
      /^\/api\/me\/knowledge-sources\/(source-upload-\d+)\/reprocess$/u
    );
    if (uploadedReprocessMatch && method === "POST") {
      const sourceIndex = uploadedSources.findIndex(
        (source) => source.id === uploadedReprocessMatch[1]
      );
      if (sourceIndex < 0) {
        await fulfillJson(route, { error: "knowledge_source_not_available" }, 404);
        return;
      }
      const previous = uploadedSources[sourceIndex]!;
      const sourceNumber = Number(previous.id.slice("source-upload-".length));
      const ready = uploadedSource({
        byteSize: previous.currentVersion?.byteSize ?? 24,
        fileName: previous.name,
        sourceNumber,
        state: "ready"
      });
      uploadedSources = uploadedSources.map((source, index) => index === sourceIndex ? ready : source);
      await fulfillJson(route, { source: uploadedSourceDetail(ready) }, 202);
      return;
    }
    if (path === "/api/me/knowledge-sources/source-e2e/viewer" && method === "GET") {
      await fulfillJson(route, {
        source: {
          blocks: [{
            boundingBoxes: [],
            headingPath: ["Product guide", "Onboarding"],
            pageEnd: 1,
            pageStart: 1,
            relation: "target",
            table: null,
            text: "Use the reusable onboarding checklist for every product launch.",
            type: "paragraph"
          }],
          excerpt: "Use the reusable onboarding checklist for every product launch.",
          excerptTruncated: false,
          headingPath: ["Product guide", "Onboarding"],
          locator: { boundingBoxes: [], pageEnd: 1, pageStart: 1 },
          originalKind: null,
          source: {
            baseName: "Product docs",
            fileName: "product-guide.pdf",
            mimeType: "application/pdf",
            name: sourceName,
            statuses: sourceTrashed ? ["trash"] : [],
            versionNumber: 2
          },
          state: "available",
          visual: null,
          workbook: null
        }
      });
      return;
    }
    if (path === "/api/me/knowledge-sources/source-e2e" && method === "GET") {
      await fulfillJson(route, { source: sourceDetail() });
      return;
    }
    if (path === "/api/me/knowledge-sources/source-e2e" && method === "PATCH") {
      const body = request.postDataJSON() as {
        description: string;
        expectedVersion: number;
        name: string;
        tags: string[];
      };
      expect(body.expectedVersion).toBe(sourceVersion);
      sourceName = body.name;
      sourceDescription = body.description;
      sourceTags = body.tags;
      sourceVersion += 1;
      await fulfillJson(route, { source: sourceDetail() });
      return;
    }
    if (path === "/api/me/knowledge-sources/source-e2e/trash" && method === "POST") {
      expect(request.postDataJSON()).toEqual({ expectedVersion: sourceVersion });
      sourceTrashed = true;
      sourceVersion += 1;
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === "/api/me/knowledge-sources/source-e2e/restore" && method === "POST") {
      expect(request.postDataJSON()).toEqual({ expectedVersion: sourceVersion });
      sourceTrashed = false;
      sourceVersion += 1;
      await route.fulfill({ status: 204 });
      return;
    }
    if (
      path === "/api/me/knowledge-sources/source-e2e/delete-permanently" &&
      method === "POST"
    ) {
      expect(request.postDataJSON()).toEqual({ expectedVersion: sourceVersion });
      sourceDeletionPending = true;
      sourceVersion += 1;
      await fulfillJson(route, { status: "pending" }, 202);
      return;
    }
    if (path === "/api/me/knowledge-sources/source-e2e/memberships" && method === "POST") {
      const body = request.postDataJSON() as { baseIds: string[] };
      sourceMembershipIds = [...new Set([...sourceMembershipIds, ...body.baseIds])];
      sourceVersion += 1;
      await fulfillJson(route, { source: sourceDetail() });
      return;
    }
    if (path === "/api/me/knowledge-sources/source-e2e/move" && method === "POST") {
      const body = request.postDataJSON() as { fromBaseId: string; toBaseId: string };
      sourceMembershipIds = sourceMembershipIds
        .filter((id) => id !== body.fromBaseId)
        .concat(body.toBaseId);
      sourceVersion += 1;
      await fulfillJson(route, { source: sourceDetail() });
      return;
    }
    if (path.startsWith("/api/me/knowledge-sources/source-e2e/memberships/") && method === "DELETE") {
      const baseId = decodeURIComponent(path.split("/").at(-1)!);
      sourceMembershipIds = sourceMembershipIds.filter((id) => id !== baseId);
      sourceVersion += 1;
      await fulfillJson(route, { source: sourceDetail() });
      return;
    }
    await route.fulfill({ json: { error: "knowledge_source_not_available" }, status: 404 });
  });
}

async function setTheme(page: Page, theme: "dark" | "light") {
  await page.evaluate((value) => window.localStorage.setItem("aiqsa.theme", value), theme);
  await page.context().addCookies([{
    name: "aiqsa.theme",
    value: theme,
    url: "http://127.0.0.1:3000"
  }]);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function setViewport(page: Page, viewport: { height: number; width: number }) {
  await page.setViewportSize(viewport);
  await page.evaluate(() => new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  }));
}

function expectUserSafeKnowledgeText(text: string) {
  for (const forbidden of [
    "chunk",
    "dimension",
    "embedding",
    "fingerprint",
    "generation",
    "provider",
    "reindex",
    "revision"
  ]) {
    expect(text.toLocaleLowerCase()).not.toContain(forbidden);
  }
}

test.beforeEach(async ({ page }) => {
  await installKnowledgeFixture(page);
  await signInWithLocalToken(page);
});

test("manages a user-safe Knowledge base across themes and contract viewports", async ({ page }) => {
  await setTheme(page, "light");
  await runAccountMenuAction(page, "Knowledge");
  const library = page.getByTestId("library-v2");
  await expect(library).toBeVisible();
  await expect(page).toHaveTitle("Library · AIQSA");

  for (const viewport of [
    { height: 844, width: 384 },
    { height: 390, width: 844 },
    { height: 800, width: 1280 },
    { height: 1024, width: 768 }
  ]) {
    await setViewport(page, viewport);
    await expectWithinViewport(page, library);
    await expect(library.getByRole("button", { name: "Back to chat" })).toBeInViewport();
    await expect(library.getByRole("button", { name: "New base" })).toBeInViewport();
    await expectNoHorizontalOverflow(page);
  }

  await setViewport(page, { height: 844, width: 384 });
  await library.getByRole("button", { name: "New base" }).click();
  const knowledge = page.getByTestId("knowledge-library");
  await expect(knowledge).toBeVisible();
  await expect(knowledge.getByRole("button", { name: "Back to Knowledge" })).toBeFocused();
  await knowledge.getByLabel("Name").fill("E2E runbooks");
  await knowledge.getByLabel("Description").fill("Operational references");
  await knowledge.getByLabel("Choose files").setInputFiles([
    { buffer: Buffer.from("# Handbook"), mimeType: "text/markdown", name: "handbook.md" },
    { buffer: Buffer.from("Incident notes"), mimeType: "text/plain", name: "incident.txt" }
  ]);
  await expect(knowledge.getByRole("list", { name: "Files selected for this Knowledge base" }))
    .toContainText("handbook.md");
  await knowledge.getByRole("button", { name: "Create knowledge base" }).click();

  await expect(knowledge.getByRole("heading", { level: 1, name: "E2E runbooks" })).toBeVisible();
  await expect(knowledge.getByRole("button", { name: "Back to Knowledge" })).toBeFocused();
  const partialFile = knowledge.getByTestId("knowledge-source-source-upload-1");
  await expect(partialFile.getByText("handbook.md", { exact: true })).toBeVisible();
  await expect(partialFile.getByText("Ready with warnings", { exact: true })).toBeVisible();
  await expect(partialFile.getByText("The usable part is searchable", { exact: true })).toBeVisible();
  const affectedFile = knowledge.getByTestId("knowledge-source-source-upload-2");
  await expect(affectedFile.getByText("Needs attention", { exact: true })).toBeVisible();
  await expect(knowledge.getByTestId("knowledge-readiness-summary"))
    .toContainText(`Support reference ${baseSupportReference}`);
  expectUserSafeKnowledgeText(await knowledge.innerText());

  await affectedFile.getByRole("button", { name: "Open Source" }).click();
  await expect(knowledge.getByRole("heading", { level: 1, name: "incident.txt" })).toBeVisible();
  await expect(knowledge).toContainText(`Support reference ${fileSupportReference}`);
  await knowledge.getByRole("button", { name: "Retry processing" }).click();
  await expect(knowledge.getByText("Ready", { exact: true }).first()).toBeVisible();
  await knowledge.getByRole("button", { name: "Back to base" }).click();
  await expect(knowledge.getByTestId("knowledge-source-source-upload-2"))
    .toContainText("Ready");

  await knowledge.getByRole("searchbox", { name: "Search Sources in this base" }).fill("incident");
  await expect(knowledge.getByTestId("knowledge-source-source-upload-2")).toContainText("incident.txt");
  await expect(knowledge.getByTestId("knowledge-source-source-upload-1")).toHaveCount(0);
  await knowledge.getByRole("searchbox", { name: "Search Sources in this base" }).fill("");
  await expect(knowledge.getByTestId("knowledge-source-source-upload-1")).toContainText("handbook.md");

  await knowledge.getByRole("button", { name: "Publish" }).click();
  await expect(knowledge.getByRole("list", { name: "Current Knowledge publications" }))
    .toContainText("Research");
  await expect(knowledge.getByTestId("knowledge-publication-disclosure"))
    .toContainText("already accepted runs are unchanged");

  await knowledge.getByRole("button", { name: "Archive" }).click();
  await expect(knowledge.getByRole("button", { name: "Restore" })).toBeVisible();
  await knowledge.getByRole("button", { name: "Restore" }).click();
  await expect(knowledge.getByRole("button", { name: "Archive" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expectUserSafeKnowledgeText(await knowledge.innerText());

  await knowledge.getByRole("button", { name: "Back to Knowledge" }).click();
  await expect(knowledge).toHaveCount(0);
  await library.getByRole("button", { name: "Back to chat" }).click();
  await expect(page).toHaveTitle("New chat · AIQSA");

  await setTheme(page, "dark");
  await runAccountMenuAction(page, "Knowledge");
  await setViewport(page, { height: 844, width: 390 });
  await expectWithinViewport(page, library);
  await expectNoHorizontalOverflow(page);
  await library.getByRole("button", { name: "Open" }).click();
  await expect(knowledge.getByRole("heading", { level: 1, name: "E2E runbooks" })).toBeVisible();
  await expectWithinViewport(page, knowledge);
  await expectNoHorizontalOverflow(page);
  expectUserSafeKnowledgeText(await knowledge.innerText());
});

test("keeps a 50-file intake receipt across reload", async ({ page }) => {
  await runAccountMenuAction(page, "Knowledge");
  const library = page.getByTestId("library-v2");
  await library.getByRole("button", { name: "New base" }).click();
  const knowledge = page.getByTestId("knowledge-library");
  await knowledge.getByLabel("Name").fill("E2E runbooks");
  await knowledge.getByLabel("Description").fill("Operational references");
  await knowledge.getByLabel("Choose files").setInputFiles(Array.from(
    { length: 50 },
    (_, index) => ({
      buffer: Buffer.from(`# File ${index + 1}`),
      mimeType: "text/markdown",
      name: `file-${String(index + 1).padStart(2, "0")}.md`
    })
  ));
  await knowledge.getByRole("button", { name: "Create knowledge base" }).click();

  await expect(knowledge.getByLabel("Upload activity").getByText(
    "48 ready · 1 transferring · 1 needs attention",
    { exact: true }
  ))
    .toBeVisible({ timeout: 90_000 });
  await expect(knowledge.getByTestId(/^knowledge-upload-item-/u)).toHaveCount(50);
  await expectNoHorizontalOverflow(page);

  await page.reload();
  await runAccountMenuAction(page, "Knowledge");
  await page.getByTestId("library-v2").getByRole("button", { name: "Open" }).click();
  const restoredKnowledge = page.getByTestId("knowledge-library");
  await expect(restoredKnowledge.getByLabel("Upload activity").getByText(
    "48 ready · 1 transferring · 1 needs attention",
    { exact: true }
  )).toBeVisible();
  const interrupted = restoredKnowledge.getByTestId("knowledge-upload-item-upload-item-1-50");
  await expect(interrupted).toContainText("file-50.md");
  await interrupted.getByLabel("Resume").setInputFiles({
    buffer: Buffer.from("# File 50"),
    mimeType: "text/markdown",
    name: "file-50.md"
  });
  await expect(restoredKnowledge.getByLabel("Upload activity").getByText(
    "49 ready · 1 needs attention",
    { exact: true }
  ))
    .toBeVisible();
});

test("reuses one Source across Bases with distinct Add, Move, and Remove journeys", async ({ page }) => {
  await runAccountMenuAction(page, "Knowledge");
  const library = page.getByTestId("library-v2");
  await library.getByRole("button", { name: "Browse Sources" }).click();
  const knowledge = page.getByTestId("knowledge-library");

  const sourceRow = knowledge.getByTestId("knowledge-source-source-e2e");
  await expect(sourceRow).toContainText("Reusable product guide");
  await expect(sourceRow).toContainText("1 base");
  await knowledge.getByRole("searchbox", { name: "Search Sources" }).fill("onboarding");
  await expect(sourceRow).toBeVisible();
  await knowledge.getByRole("searchbox", { name: "Search Sources" }).fill("");

  for (const viewport of [
    { height: 844, width: 384 },
    { height: 390, width: 844 },
    { height: 800, width: 1280 }
  ]) {
    await setViewport(page, viewport);
    await expectWithinViewport(page, knowledge);
    await expectNoHorizontalOverflow(page);
  }

  await setViewport(page, { height: 844, width: 384 });
  await sourceRow.getByRole("button").click();
  await expect(knowledge.getByRole("heading", { level: 1, name: "Reusable product guide" }))
    .toBeVisible();
  await expect(knowledge.getByText("One canonical file identity, reused wherever you add it."))
    .toBeVisible();
  const previewSource = knowledge.getByRole("button", { name: "Preview" });
  await previewSource.click();
  const sourceViewer = page.getByRole("dialog", { name: "Knowledge source viewer" });
  await expect(sourceViewer).toContainText(
    "Use the reusable onboarding checklist for every product launch."
  );
  await sourceViewer.getByRole("button", { name: "Close source viewer" }).click();
  await expect(previewSource).toBeFocused();
  await expect(knowledge.getByText("Some table structure was simplified")).toBeVisible();

  await knowledge.getByLabel("Name").fill("Reusable product handbook");
  await knowledge.getByLabel("Tags").fill("product, policy");
  await knowledge.getByRole("button", { name: "Save details" }).click();
  await expect(knowledge.getByTestId("knowledge-library-notice")).toContainText("Source details saved");

  await knowledge.getByLabel("Assistant docs").check();
  await knowledge.getByRole("button", { name: "Add to selected" }).click();
  await expect(knowledge.getByRole("list", { name: "Source Base memberships" }))
    .toContainText("Assistant docs");

  await knowledge.getByRole("button", { name: "Move Source" }).click();
  const memberships = knowledge.getByRole("list", { name: "Source Base memberships" });
  await expect(memberships).not.toContainText("Product docs");
  await expect(memberships).toContainText("Project docs");

  const assistantMembership = memberships.getByRole("listitem").filter({ hasText: "Assistant docs" });
  await assistantMembership.getByRole("button", { name: "Remove from base" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Remove Reusable product handbook from Assistant docs"
  });
  await expect(confirmation).toContainText("stays in your library and in its other bases");
  await confirmation.getByRole("button", { name: "Confirm remove from base" }).click();
  await expect(memberships).not.toContainText("Assistant docs");
  await expect(memberships).toContainText("Project docs");

  await knowledge.getByText("Version history · 2").click();
  await expect(knowledge.getByRole("list", { name: "Source versions" }))
    .toContainText("product-guide-v1.pdf");
  await expectNoHorizontalOverflow(page);
  expectUserSafeKnowledgeText(await knowledge.innerText());
});

test("moves a Source through Trash, restore, and durable permanent deletion", async ({ page }) => {
  await runAccountMenuAction(page, "Knowledge");
  const library = page.getByTestId("library-v2");
  await library.getByRole("button", { name: "Browse Sources" }).click();
  const knowledge = page.getByTestId("knowledge-library");
  await knowledge.getByTestId("knowledge-source-source-e2e").getByRole("button").click();

  await knowledge.getByRole("button", {
    name: "Move Reusable product guide to Trash"
  }).click();
  const firstTrash = page.getByRole("dialog", {
    name: "Move to Trash Reusable product guide"
  });
  await expect(firstTrash).toContainText("Future runs exclude this Source from every base");
  await firstTrash.getByRole("button", { name: "Confirm move to trash" }).click();
  await expect(knowledge.getByRole("heading", { name: "Source is in Trash" })).toBeVisible();
  await expect(knowledge).toContainText("purge scheduled");
  await expect(knowledge.getByLabel("Source Base memberships")).toHaveCount(0);

  await knowledge.getByRole("button", { name: "Restore" }).click();
  await expect(knowledge.getByRole("button", {
    name: "Move Reusable product guide to Trash"
  })).toBeVisible();

  await knowledge.getByRole("button", {
    name: "Move Reusable product guide to Trash"
  }).click();
  await page.getByRole("dialog", {
    name: "Move to Trash Reusable product guide"
  }).getByRole("button", { name: "Confirm move to trash" }).click();
  await knowledge.getByRole("button", { name: "Delete permanently" }).click();
  const permanent = page.getByRole("dialog", {
    name: "Permanently delete Reusable product guide"
  });
  await expect(permanent).toContainText("every version, indexed copy, and stored file");
  await permanent.getByRole("button", { name: "Confirm delete permanently" }).click();
  await expect(knowledge.getByTestId("knowledge-library-notice"))
    .toContainText("Permanent Source deletion started");
  await knowledge.getByRole("button", { name: "Trash" }).click();
  const pendingSource = knowledge.getByTestId("knowledge-source-source-e2e");
  await expect(pendingSource).toContainText("Deletion pending");
  await pendingSource.getByRole("button").click();
  await expect(knowledge.getByRole("heading", { name: "Permanent deletion pending" }))
    .toBeVisible();
  await expect(knowledge.getByRole("button", { name: "Restore" })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
