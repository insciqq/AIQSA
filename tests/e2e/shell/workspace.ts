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

export async function cleanupE2eWorkspace(page: Page): Promise<string> {
  const response = await page.request.get("/api/chats");
  if (!response.ok()) {
    return "Fake / Fake QSA";
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

  const preferredSettings = await page.request.patch("/api/me/settings", {
    data: {
      defaultControlValues: {
        "openai:gpt-5.5": {
          backgroundMode: true,
          maxOutputTokens: "128000",
          reasoningEffort: "medium",
          streamMode: false,
          temperature: "1"
        }
      },
      defaultModelId: "gpt-5.5",
      defaultProvider: "openai",
      defaultSearchStrategyId: "search-disabled",
      showCitations: true,
      showReasoningBlocks: false,
      showToolActivity: true,
    }
  });
  if (preferredSettings.ok()) {
    return "OpenAI / GPT-5.5";
  }

  const fallbackSettings = await page.request.patch("/api/me/settings", {
    data: {
      defaultModelId: "fake-qsa",
      defaultProvider: "fake",
      defaultSearchStrategyId: "search-disabled",
      showCitations: true,
      showReasoningBlocks: false,
      showToolActivity: true,
    }
  });
  if (!fallbackSettings.ok()) {
    throw new Error("Unable to reset E2E settings to an available deterministic model");
  }

  return "Fake / Fake QSA";
}
