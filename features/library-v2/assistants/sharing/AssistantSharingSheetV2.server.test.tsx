// @vitest-environment node
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AssistantSharingSheetView } from "@/components/assistants/libraryViewContracts";
import { assistantDetail } from "@/tests/support/assistantLibraryFixtures";
import { AssistantSharingSheetV2 } from "./AssistantSharingSheetV2";

function openView(): AssistantSharingSheetView {
  const noop = () => undefined;
  return {
    assistantId: "assistant-1",
    detail: assistantDetail(),
    dirty: false,
    draft: { audience: "owner", featured: false, featuredOrder: 0, groupIds: [] },
    error: null,
    failures: [],
    featuredCount: 0,
    groups: [],
    isAdministrator: false,
    listing: null,
    name: "Code reviewer",
    names: { knowledgeBases: [], knowledgeSources: [], mcpServers: [], models: [], searchOptions: [] },
    onChange: noop,
    onClose: noop,
    onCopyLink: async () => true,
    onRetry: noop,
    onSave: async () => true,
    onWithdrawRequest: noop,
    saving: false,
    state: "ready",
    withdrawing: false
  };
}

describe("Assistant Sharing sheet on the server", () => {
  it("renders open without a DOM, so a page that shows it keeps its server render", () => {
    expect(typeof document).toBe("undefined");
    expect(() => renderToString(<AssistantSharingSheetV2 view={openView()} />)).not.toThrow();
  });
});
