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
    parentId: string | null;
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
    (folder) =>
      folder.name.startsWith("E2E Folder ") ||
      folder.name.startsWith("E2E Subfolder ") ||
      folder.name.startsWith("Evidence Folder ")
  );
  const folderIds = new Set(folders.map((folder) => folder.id));
  const chats = body.chats.filter(
    (chat) => folderIds.has(chat.folderId ?? "") || chat.title.startsWith("Folder path e2e question ")
  );

  for (const chat of chats) {
    const deleteResponse = await page.request.delete(`/api/chats/${chat.id}`);
    if (!deleteResponse.ok() && deleteResponse.status() !== 404) {
      throw new Error(`Unable to delete E2E chat ${chat.id}`);
    }
  }

  const foldersById = new Map(body.folders.map((folder) => [folder.id, folder]));
  const folderDepth = (folder: WorkspaceBody["folders"][number]) => {
    let depth = 0;
    let parentId = folder.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      depth += 1;
      parentId = foldersById.get(parentId)?.parentId ?? null;
    }
    return depth;
  };

  for (const folder of [...folders].sort((left, right) => folderDepth(right) - folderDepth(left))) {
    const deleteResponse = await page.request.delete(`/api/folders/${folder.id}`);
    if (!deleteResponse.ok() && deleteResponse.status() !== 404) {
      throw new Error(`Unable to delete E2E folder ${folder.id}`);
    }
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
      defaultSearchPlan: { mode: "all_selected", optionIds: [] },
      showCitations: true,
      showReasoningBlocks: false,
    }
  });
  if (!settingsResponse.ok()) {
    throw new Error("Unable to reset E2E settings to an available deterministic model");
  }

  const providerName =
    catalog.providers.find((provider) => provider.id === fakeModel.provider)?.name ?? "Fake QSA";
  return `${providerName} / ${fakeModel.displayName}`;
}
