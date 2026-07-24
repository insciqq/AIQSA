import type { Page } from "@playwright/test";

type WorkspaceBody = {
  chats: {
    folderId: string | null;
    id: string;
    title: string;
  }[];
  folders: {
    id: string;
    name: string;
  }[];
};

type CatalogBody = {
  catalog: {
    models: {
      displayName: string;
      modelId: string;
      provider: string;
      providerFamily: string;
      upstreamModelId: string;
    }[];
    providers: {
      id: string;
      name: string;
    }[];
  };
};

export async function cleanupE2eWorkspace(page: Page): Promise<string> {
  const response = await page.request.get("/api/chats");
  if (!response.ok()) {
    throw new Error("Unable to load the E2E workspace");
  }

  const body = (await response.json()) as WorkspaceBody;
  const folders = body.folders.filter(
    (folder) => folder.name.startsWith("E2E Folder ") || folder.name.startsWith("Evidence Folder ")
  );
  const folderIds = new Set(folders.map((folder) => folder.id));
  const chats = body.chats.filter(
    (chat) => folderIds.has(chat.folderId ?? "") || chat.title.startsWith("Folder path e2e question ")
  );

  for (const chat of chats) {
    await page.request.delete(`/api/chats/${chat.id}`);
  }

  for (const folder of folders) {
    await page.request.delete(`/api/folders/${folder.id}`);
  }

  const catalogResponse = await page.request.get("/api/me/catalog");
  if (!catalogResponse.ok()) {
    throw new Error("Unable to load the E2E model catalog");
  }

  const { catalog } = (await catalogResponse.json()) as CatalogBody;
  const fakeModel = catalog.models.find(
    (model) => model.providerFamily === "fake" && model.upstreamModelId === "fake-qsa"
  );
  if (!fakeModel) {
    throw new Error("Unable to find the deterministic Fake QSA model in the E2E catalog");
  }

  const settingsResponse = await page.request.patch("/api/me/settings", {
    data: {
      defaultModelId: fakeModel.modelId,
      defaultProvider: fakeModel.provider,
      defaultSearchStrategyId: "search-disabled",
      showCitations: true,
      showReasoningBlocks: false,
      showToolActivity: true,
    }
  });
  if (!settingsResponse.ok()) {
    throw new Error("Unable to reset E2E settings to an available deterministic model");
  }

  const providerName =
    catalog.providers.find((provider) => provider.id === fakeModel.provider)?.name ?? "Fake QSA";
  return `${providerName} / ${fakeModel.displayName}`;
}
