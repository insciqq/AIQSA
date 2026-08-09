import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { runAccountMenuAction } from "./shell/page";

test.setTimeout(60_000);

const timestamp = "2026-08-08T10:00:00.000Z";
const embeddingDeployment = {
  connectionDisplayName: "E2E embedding connection",
  id: "embedding-e2e",
  indexSupported: true,
  modelDisplayName: "E2E embedding model",
  provider: "openai_compatible",
  targetDimension: 1536
};

function version(input: {
  documentNumber: number;
  errorCode?: string | null;
  state: "failed" | "queued" | "ready";
}) {
  const ready = input.state === "ready";
  return {
    byteSize: 24,
    completedAt: ready ? timestamp : null,
    createdAt: timestamp,
    current: true,
    embeddedChunks: ready ? 2 : 0,
    errorCode: input.errorCode ?? null,
    fileName: input.documentNumber === 1 ? "handbook.md" : "incident.txt",
    id: `version-${input.documentNumber}`,
    mimeType: input.documentNumber === 1 ? "text/markdown" : "text/plain",
    pageCount: null,
    payloadAvailable: true,
    state: input.state,
    totalChunks: ready || input.state === "failed" ? 2 : null,
    updatedAt: timestamp,
    versionNumber: 1,
    visibleFromRevision: ready ? input.documentNumber : null,
    visibleUntilRevision: null
  };
}

function document(input: {
  documentNumber: number;
  errorCode?: string | null;
  state: "failed" | "queued" | "ready";
}) {
  const current = version(input);
  return {
    archived: false,
    currentVersionId: current.id,
    id: `document-${input.documentNumber}`,
    versions: [current]
  };
}

async function installKnowledgeFixture(page: Page) {
  let created = false;
  let uploadCount = 0;
  let archived = false;
  let baseVersion = 1;
  let contentRevision = 0;
  let indexedContentRevision = 0;
  let documents: ReturnType<typeof document>[] = [];
  let publications: Array<{
    groupId: string | null;
    groupName: string | null;
    id: string;
    scope: "group" | "installation";
    updatedAt: string;
  }> = [];
  let reindex: {
    completedDocuments: number;
    createdAt: string;
    errorCode: string | null;
    failedDocuments: number;
    generationId: string;
    status: "building";
    targetContentRevision: number;
    totalDocuments: number;
  } | null = null;

  function summary() {
    return {
      activeGeneration: {
        chunkingProfileVersion: 1,
        embeddingDeployment,
        embeddingDeploymentId: embeddingDeployment.id,
        id: "generation-e2e",
        indexedContentRevision,
        targetDimension: 1536,
        vectorSpaceFingerprint: "e2e-vector-space"
      },
      archived,
      contentRevision,
      description: "Operational references",
      id: "base-e2e",
      name: "E2E runbooks",
      owned: true,
      ownerDisplayName: "E2E operator",
      published: publications.length > 0,
      scope: { kind: "owner" as const },
      updatedAt: timestamp,
      version: baseVersion
    };
  }

  function detail() {
    return {
      ...summary(),
      documentCount: documents.filter((entry) => !entry.archived).length,
      publications
    };
  }

  async function fulfillJson(route: Route, json: unknown, status = 200) {
    await route.fulfill({ json, status });
  }

  await page.route("**/api/me/knowledge-bases**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;

    if (path === "/api/me/knowledge-bases" && method === "GET") {
      await fulfillJson(route, {
        embeddingDeployments: [embeddingDeployment],
        knowledgeBases: created ? [summary()] : [],
        publishableGroups: [{ id: "group-e2e", name: "Research" }],
        viewer: { canPublishInstallation: true }
      });
      return;
    }
    if (path === "/api/me/knowledge-bases" && method === "POST") {
      expect(request.postDataJSON()).toEqual({
        description: "Operational references",
        embeddingDeploymentId: "embedding-e2e",
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
      const body = request.postDataJSON() as { archived?: boolean };
      if (typeof body.archived === "boolean") archived = body.archived;
      baseVersion += 1;
      await fulfillJson(route, { knowledgeBase: detail() });
      return;
    }
    if (path === "/api/me/knowledge-bases/base-e2e/documents" && method === "GET") {
      const search = new URL(request.url()).searchParams;
      const query = (search.get("q") ?? "").trim();
      const pageSize = Number(search.get("pageSize") ?? "25");
      const matching = documents.filter((entry) =>
        entry.versions.some((entryVersion) =>
          entryVersion.fileName.toLocaleLowerCase().includes(query.toLocaleLowerCase())
        )
      );
      const totalPages = matching.length === 0 ? 0 : Math.ceil(matching.length / pageSize);
      const requestedPage = Number(search.get("page") ?? "1");
      const pageNumber = Math.min(requestedPage, Math.max(1, totalPages));
      const pageDocuments = matching.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
      await fulfillJson(route, {
        documents: pageDocuments,
        owned: true,
        pagination: {
          page: pageNumber,
          pageSize,
          query,
          totalItems: matching.length,
          totalPages
        },
        reindex
      });
      return;
    }
    if (path === "/api/me/knowledge-bases/base-e2e/documents" && method === "POST") {
      uploadCount += 1;
      const next = uploadCount === 1
        ? document({ documentNumber: 1, state: "ready" })
        : document({ documentNumber: 2, errorCode: "embedding_failed", state: "failed" });
      documents = [...documents, next];
      if (uploadCount === 1) {
        contentRevision = 1;
        indexedContentRevision = 1;
      }
      await fulfillJson(route, { document: next }, 202);
      return;
    }
    if (path.endsWith("/retry") && method === "POST") {
      const retried = document({ documentNumber: 2, state: "ready" });
      documents = documents.map((entry) => entry.id === retried.id ? retried : entry);
      contentRevision = 2;
      indexedContentRevision = 2;
      await fulfillJson(route, { document: retried }, 202);
      return;
    }
    if (path === "/api/me/knowledge-bases/base-e2e/reindex" && method === "POST") {
      expect(request.postDataJSON()).toEqual({ embeddingDeploymentId: "embedding-e2e" });
      reindex = {
        completedDocuments: 0,
        createdAt: timestamp,
        errorCode: null,
        failedDocuments: 0,
        generationId: "generation-shadow-e2e",
        status: "building",
        targetContentRevision: contentRevision,
        totalDocuments: documents.length
      };
      await fulfillJson(route, { reindex }, 202);
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
}

test.beforeEach(async ({ page }) => {
  await signInWithLocalToken(page);
  await installKnowledgeFixture(page);
});

test("manages a Knowledge base and stays contained at every contract viewport", async ({ page }) => {
  await runAccountMenuAction(page, "Knowledge");
  const library = page.getByTestId("knowledge-library");
  await expect(library).toBeVisible();
  await expect(page).toHaveTitle("Knowledge · AIQSA");

  for (const viewport of [
    { height: 844, width: 384 },
    { height: 390, width: 844 },
    { height: 1024, width: 768 },
    { height: 800, width: 1280 }
  ]) {
    await page.setViewportSize(viewport);
    await expectWithinViewport(page, library);
    await expect(library.getByRole("button", { name: "Back to chat" })).toBeInViewport();
    await expect(library.getByRole("button", { name: "New base" })).toBeInViewport();
    await expectNoHorizontalOverflow(page);
  }

  await page.setViewportSize({ height: 844, width: 384 });
  await library.getByRole("button", { name: "New base" }).click();
  await expect(library.getByTestId("knowledge-egress-disclosure")).toContainText(
    "E2E embedding connection / E2E embedding model"
  );
  await library.getByLabel("Name").fill("E2E runbooks");
  await library.getByLabel("Description").fill("Operational references");
  await library.getByRole("button", { name: "Create base" }).click();
  await expect(library.getByRole("heading", { level: 1, name: "E2E runbooks" })).toBeVisible();
  await expect(library.getByTestId("knowledge-revision-spine")).toBeVisible();

  await library.locator('input[type="file"][multiple]').setInputFiles([
    { buffer: Buffer.from("# Handbook"), mimeType: "text/markdown", name: "handbook.md" },
    { buffer: Buffer.from("Incident notes"), mimeType: "text/plain", name: "incident.txt" }
  ]);
  await expect(library.getByText("handbook.md", { exact: true })).toBeVisible();
  await expect(library.getByText("incident.txt", { exact: true })).toBeVisible();
  await expect(library.getByText("Code: embedding_failed")).toBeVisible();
  await library.getByRole("button", { name: "Retry" }).click();
  await expect(
    library.getByTestId("knowledge-document-document-1").getByText("2 chunks ready").first()
  ).toBeVisible();
  await expect(
    library.getByTestId("knowledge-document-document-2").getByText("2 chunks ready").first()
  ).toBeVisible();
  await library.getByRole("searchbox", { name: "Search documents by filename" }).fill("incident");
  await expect(library.getByText("incident.txt", { exact: true })).toBeVisible();
  await expect(library.getByText("handbook.md", { exact: true })).toHaveCount(0);
  await library.getByRole("searchbox", { name: "Search documents by filename" }).fill("");
  await expect(library.getByText("handbook.md", { exact: true })).toBeVisible();

  await library.getByRole("button", { name: "Start reindex" }).click();
  await expect(library.getByText("Building shadow index")).toBeVisible();
  await expect(library.getByText("0 completed · 0 failed · 2 total · target revision 2")).toBeVisible();

  await library.getByRole("button", { name: "Publish" }).click();
  await expect(library.getByRole("list", { name: "Current Knowledge publications" })).toContainText("Research");
  await expect(library.getByTestId("knowledge-publication-disclosure")).toContainText(
    "runs accepted earlier keep their frozen evidence"
  );

  await library.getByRole("button", { name: "Archive" }).click();
  await expect(library.getByRole("button", { name: "Restore" })).toBeVisible();
  await library.getByRole("button", { name: "Restore" }).click();
  await expect(library.getByRole("button", { name: "Archive" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await library.getByRole("button", { name: "Back to Knowledge" }).click();
  await library.getByRole("button", { name: "Back to chat" }).click();
  await expect(page).toHaveTitle("New chat · AIQSA");
  for (const viewport of [
    { height: 844, width: 384 },
    { height: 390, width: 844 },
    { height: 1024, width: 768 },
    { height: 800, width: 1280 }
  ]) {
    await page.setViewportSize(viewport);
    const picker = page.locator("#composer-inline-knowledge");
    await expect(picker).toBeVisible();
    await expectWithinViewport(page, picker);
    await picker.click();
    const dialog = page.getByTestId("composer-inline-knowledge-options");
    await expect(dialog).toBeVisible();
    await expectWithinViewport(page, dialog);
    await expectNoHorizontalOverflow(page);
    if (viewport.width === 384) {
      await dialog.getByRole("button", { name: /E2E runbooks/ }).click();
      await expect(picker).toHaveAccessibleName(/E2E runbooks.*Next-run plan/);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
});
