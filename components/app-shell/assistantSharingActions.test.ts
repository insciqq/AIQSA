import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantDetail } from "@/lib/contracts/assistants";
import type { AssistantListingStatus } from "@/lib/contracts/assistantListing";
import {
  resetAssistantLibraryStoreForTest,
  resetComposerControlStoreForTest
} from "@/tests/support/appShellStores";
import {
  assistantControllerInput,
  assistantDetail,
  assistantList,
  assistantSummary
} from "@/tests/support/assistantLibraryFixtures";
import { useAssistantLibraryStore } from "./assistantLibraryStore";
import {
  buildAssistantLibraryView,
  createAssistantLibraryActions
} from "./assistantLibraryController";

const mocks = vi.hoisted(() => ({
  fetchAssistantDetail: vi.fn(),
  fetchAssistantList: vi.fn(),
  loadUserMcpServers: vi.fn(),
  publishAssistant: vi.fn(),
  requestAssistantListing: vi.fn(),
  revokeAssistantPublication: vi.fn(),
  setAssistantFeaturedOrder: vi.fn(),
  withdrawAssistantListingRequest: vi.fn(),
  writeClipboardText: vi.fn()
}));

vi.mock("@/components/clipboard/writeClipboardText", () => ({
  writeClipboardText: mocks.writeClipboardText
}));

vi.mock("@/components/assistants/assistantsApi", () => ({
  fetchAssistantDetail: mocks.fetchAssistantDetail,
  fetchAssistantList: mocks.fetchAssistantList,
  publishAssistant: mocks.publishAssistant,
  requestAssistantListing: mocks.requestAssistantListing,
  revokeAssistantPublication: mocks.revokeAssistantPublication,
  setAssistantFeaturedOrder: mocks.setAssistantFeaturedOrder,
  withdrawAssistantListingRequest: mocks.withdrawAssistantListingRequest
}));

vi.mock("@/components/app-shell/mcpSettingsApi", () => ({
  loadUserMcpServers: mocks.loadUserMcpServers
}));

const store = () => useAssistantLibraryStore.getState();

const pendingListing: AssistantListingStatus = {
  canRequest: false,
  canWithdraw: true,
  listed: false,
  request: {
    createdAt: "2026-09-27T00:00:00.000Z",
    definitionVersion: 3,
    id: "request-1",
    outdated: false,
    reviewNote: null,
    reviewedAt: null,
    state: "pending"
  }
};

function groupPublication(groupId: string) {
  return { groupId, groupName: groupId, id: `pub-${groupId}`, scope: "group" as const, updatedAt: "2026-09-20T00:00:00.000Z" };
}

const installation = {
  groupId: null,
  groupName: null,
  id: "pub-installation",
  scope: "installation" as const,
  updatedAt: "2026-09-20T00:00:00.000Z"
};

const skillMismatch = {
  code: "assistant_skill_audience_mismatch",
  message: "Share every included Skill with this audience before publishing the Assistant.",
  ok: false,
  skills: ["Incident brief"],
  status: 409
} as const;

function view(input = assistantControllerInput(), actions = createAssistantLibraryActions(input)) {
  return buildAssistantLibraryView(input, actions, store())!;
}

function setViewer(isAdministrator: boolean) {
  store().patch({
    data: assistantList({
      assistants: [assistantSummary(), assistantSummary({ featured: true, featuredOrder: 0, id: "assistant-9" })],
      publishableGroups: [{ id: "group-a", memberCount: 3, name: "Group A" }, { id: "group-b", memberCount: 1, name: "Group B" }],
      viewer: { canPublishInstallation: isAdministrator, defaultAssistantId: null }
    }),
    dataState: "ready",
    open: true
  });
}

async function openSharing(detail: AssistantDetail) {
  mocks.fetchAssistantDetail.mockResolvedValueOnce({ data: detail, ok: true });
  view().gallery.onShare(detail.id);
  await vi.waitFor(() => expect(view().sharing?.state).toBe("ready"));
}

beforeEach(() => {
  vi.resetAllMocks();
  resetAssistantLibraryStoreForTest();
  resetComposerControlStoreForTest();
  mocks.fetchAssistantList.mockResolvedValue({ data: assistantList(), ok: true });
  mocks.loadUserMcpServers.mockResolvedValue([]);
  mocks.publishAssistant.mockResolvedValue({ data: undefined, ok: true });
  mocks.revokeAssistantPublication.mockResolvedValue({ data: undefined, ok: true });
});

describe("Assistant Sharing sheet", () => {
  it("reads the saved audience and applies a group change as one action", async () => {
    setViewer(false);
    await openSharing(assistantDetail(3, { publications: [groupPublication("group-a")] }));
    expect(view().sharing).toMatchObject({
      dirty: false,
      draft: { audience: "groups", groupIds: ["group-a"] },
      featuredCount: 1,
      isAdministrator: false
    });

    view().sharing!.onChange({ groupIds: ["group-b"] });
    expect(view().sharing?.dirty).toBe(true);
    expect(view().dirty).toBe(true);
    mocks.fetchAssistantDetail.mockResolvedValueOnce({
      data: assistantDetail(3, { publications: [groupPublication("group-b")] }),
      ok: true
    });

    await expect(view().sharing!.onSave()).resolves.toBe(true);

    expect(mocks.revokeAssistantPublication).toHaveBeenCalledWith("assistant-1", "pub-group-a");
    expect(mocks.publishAssistant).toHaveBeenCalledWith("assistant-1", { groupId: "group-b", scope: "group" });
    // The new group has it before the old one loses it.
    expect(mocks.publishAssistant.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.revokeAssistantPublication.mock.invocationCallOrder[0]!);
    expect(store()).toMatchObject({ notice: { kind: "success", text: "Sharing updated." }, sharing: null });
  });

  it("takes nothing away when the group that replaces another fails", async () => {
    setViewer(false);
    await openSharing(assistantDetail(3, { publications: [groupPublication("group-a")] }));
    view().sharing!.onChange({ groupIds: ["group-b"] });
    mocks.publishAssistant.mockResolvedValueOnce(skillMismatch);
    mocks.fetchAssistantDetail.mockResolvedValueOnce({
      data: assistantDetail(3, { publications: [groupPublication("group-a")] }),
      ok: true
    });

    await expect(view().sharing!.onSave()).resolves.toBe(false);

    expect(mocks.revokeAssistantPublication).not.toHaveBeenCalled();
    expect(view().sharing).toMatchObject({
      draft: { audience: "groups", groupIds: ["group-b"] },
      failures: [{ target: { groupId: "group-b", kind: "group" } }],
      saving: false
    });
    expect(view().sharing?.dirty).toBe(true);
  });

  it("keeps the listing for everyone when the groups that replace it fail", async () => {
    setViewer(true);
    await openSharing(assistantDetail(3, { publications: [installation] }));
    view().sharing!.onChange({ audience: "groups", groupIds: ["group-a", "group-b"] });
    mocks.publishAssistant
      .mockResolvedValueOnce({ data: undefined, ok: true })
      .mockResolvedValueOnce(skillMismatch);
    mocks.fetchAssistantDetail.mockResolvedValueOnce({
      data: assistantDetail(3, { publications: [installation, groupPublication("group-a")] }),
      ok: true
    });

    await expect(view().sharing!.onSave()).resolves.toBe(false);

    expect(mocks.publishAssistant).toHaveBeenCalledTimes(2);
    expect(mocks.revokeAssistantPublication).not.toHaveBeenCalled();
    expect(view().sharing?.failures).toEqual([expect.objectContaining({ target: { groupId: "group-b", kind: "group" } })]);
  });

  it("keeps a pending request when the group that replaces it fails, and withdraws it once the group has it", async () => {
    setViewer(false);
    await openSharing(assistantDetail(3, { listingRequest: pendingListing }));
    view().sharing!.onChange({ audience: "groups", groupIds: ["group-a"] });
    mocks.publishAssistant.mockResolvedValueOnce(skillMismatch);
    mocks.fetchAssistantDetail.mockResolvedValueOnce({ data: assistantDetail(3, { listingRequest: pendingListing }), ok: true });

    await expect(view().sharing!.onSave()).resolves.toBe(false);
    expect(mocks.withdrawAssistantListingRequest).not.toHaveBeenCalled();

    // Saving again once the Skill reaches the group: the group first, then the request goes.
    view().sharing!.onChange({ groupIds: ["group-a"] });
    mocks.withdrawAssistantListingRequest.mockResolvedValue({
      data: { ...pendingListing, canRequest: true, canWithdraw: false, request: null },
      ok: true
    });
    mocks.fetchAssistantDetail.mockResolvedValueOnce({
      data: assistantDetail(3, { publications: [groupPublication("group-a")] }),
      ok: true
    });

    await expect(view().sharing!.onSave()).resolves.toBe(true);
    expect(mocks.publishAssistant.mock.invocationCallOrder[1])
      .toBeLessThan(mocks.withdrawAssistantListingRequest.mock.invocationCallOrder[0]!);
  });

  it("reports a removal that failed after everything given succeeded, and keeps the other removals", async () => {
    setViewer(false);
    await openSharing(assistantDetail(3, { publications: [groupPublication("group-a"), groupPublication("group-b")] }));
    view().sharing!.onChange({ audience: "owner" });
    mocks.revokeAssistantPublication
      .mockResolvedValueOnce({ data: undefined, ok: true })
      .mockResolvedValueOnce({ code: "assistant_not_available", message: "Gone", ok: false, status: 404 });
    mocks.fetchAssistantDetail.mockResolvedValueOnce({
      data: assistantDetail(3, { publications: [groupPublication("group-b")] }),
      ok: true
    });

    await expect(view().sharing!.onSave()).resolves.toBe(false);

    expect(mocks.revokeAssistantPublication).toHaveBeenNthCalledWith(1, "assistant-1", "pub-group-a");
    expect(mocks.revokeAssistantPublication).toHaveBeenNthCalledWith(2, "assistant-1", "pub-group-b");
    expect(view().sharing?.failures).toEqual([expect.objectContaining({ target: { groupId: "group-b", kind: "group" } })]);
  });

  it("turns Featured off for an administrator who stays listed for everyone", async () => {
    setViewer(true);
    await openSharing(assistantDetail(3, { featured: true, featuredOrder: 0, publications: [installation] }));
    view().sharing!.onChange({ featured: false });
    mocks.setAssistantFeaturedOrder.mockResolvedValue({ data: [], ok: true });
    mocks.fetchAssistantDetail.mockResolvedValueOnce({ data: assistantDetail(3, { publications: [installation] }), ok: true });

    await expect(view().sharing!.onSave()).resolves.toBe(true);

    expect(mocks.setAssistantFeaturedOrder).toHaveBeenCalledWith("assistant-1", null);
    expect(mocks.publishAssistant).not.toHaveBeenCalled();
    expect(mocks.revokeAssistantPublication).not.toHaveBeenCalled();
  });

  it("keeps the sheet open and names the Skills at the group that failed", async () => {
    setViewer(false);
    await openSharing(assistantDetail());
    view().sharing!.onChange({ audience: "groups", groupIds: ["group-a", "group-b"] });
    mocks.publishAssistant
      .mockResolvedValueOnce({ data: undefined, ok: true })
      .mockResolvedValueOnce({
        code: "assistant_skill_audience_mismatch",
        message: "Share every included Skill with this audience before publishing the Assistant.",
        ok: false,
        skills: ["Incident brief"],
        status: 409
      });
    mocks.fetchAssistantDetail.mockResolvedValueOnce({
      data: assistantDetail(3, { publications: [groupPublication("group-a")] }),
      ok: true
    });

    await expect(view().sharing!.onSave()).resolves.toBe(false);

    expect(view().sharing).toMatchObject({
      draft: { audience: "groups", groupIds: ["group-a", "group-b"] },
      failures: [{
        code: "assistant_skill_audience_mismatch",
        skills: ["Incident brief"],
        target: { groupId: "group-b", kind: "group" }
      }],
      saving: false
    });
    expect(view().sharing?.dirty).toBe(true);
  });

  it("asks an administrator to list for everyone before setting the Featured position", async () => {
    setViewer(true);
    await openSharing(assistantDetail());
    expect(view().sharing?.draft).toMatchObject({ audience: "owner", featured: false, featuredOrder: 1 });
    view().sharing!.onChange({ audience: "everyone", featured: true, featuredOrder: 0 });
    mocks.setAssistantFeaturedOrder.mockResolvedValue({ data: [{ assistantId: "assistant-1", featuredOrder: 0 }], ok: true });
    mocks.fetchAssistantDetail.mockResolvedValueOnce({ data: assistantDetail(), ok: true });

    await view().sharing!.onSave();

    expect(mocks.publishAssistant).toHaveBeenCalledWith("assistant-1", { scope: "installation" });
    expect(mocks.setAssistantFeaturedOrder).toHaveBeenCalledWith("assistant-1", 0);
    expect(mocks.publishAssistant.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.setAssistantFeaturedOrder.mock.invocationCallOrder[0]!);
  });

  it("requests listing for a non-administrator and withdraws it when leaving Everyone", async () => {
    setViewer(false);
    await openSharing(assistantDetail());
    view().sharing!.onChange({ audience: "everyone" });
    mocks.requestAssistantListing.mockResolvedValue({ data: pendingListing, ok: true });
    mocks.fetchAssistantDetail.mockResolvedValueOnce({ data: assistantDetail(3, { listingRequest: pendingListing }), ok: true });
    await view().sharing!.onSave();
    expect(mocks.requestAssistantListing).toHaveBeenCalledWith("assistant-1", 3);
    expect(mocks.publishAssistant).not.toHaveBeenCalled();

    await openSharing(assistantDetail(3, { listingRequest: pendingListing }));
    expect(view().sharing?.draft.audience).toBe("everyone");
    view().sharing!.onChange({ audience: "owner" });
    mocks.withdrawAssistantListingRequest.mockResolvedValue({
      data: { ...pendingListing, canRequest: true, canWithdraw: false, request: null },
      ok: true
    });
    mocks.fetchAssistantDetail.mockResolvedValueOnce({ data: assistantDetail(), ok: true });
    await view().sharing!.onSave();
    expect(mocks.withdrawAssistantListingRequest).toHaveBeenCalledWith("assistant-1", "request-1");
  });

  it("withdraws a pending request from the sheet and shows the new status", async () => {
    setViewer(false);
    await openSharing(assistantDetail(3, { listingRequest: pendingListing }));
    mocks.withdrawAssistantListingRequest.mockResolvedValue({
      data: { ...pendingListing, canRequest: true, canWithdraw: false, request: { ...pendingListing.request!, state: "withdrawn" } },
      ok: true
    });

    view().sharing!.onWithdrawRequest();

    await vi.waitFor(() => expect(view().sharing?.listing?.request?.state).toBe("withdrawn"));
    expect(view().sharing).toMatchObject({ dirty: false, draft: { audience: "owner" }, withdrawing: false });
  });

  it("keeps the saved groups under Everyone and clears them for Only me", async () => {
    setViewer(false);
    await openSharing(assistantDetail(3, { publications: [groupPublication("group-a")] }));
    view().sharing!.onChange({ groupIds: ["group-a", "group-b"] });

    view().sharing!.onChange({ audience: "everyone" });
    expect(view().sharing?.draft).toMatchObject({ audience: "everyone", groupIds: ["group-a"] });
    view().sharing!.onChange({ audience: "owner" });
    expect(view().sharing?.draft).toMatchObject({ audience: "owner", groupIds: [] });
  });

  it("leaves an outdated request alone when saving another change", async () => {
    setViewer(false);
    const outdated: AssistantListingStatus = {
      ...pendingListing,
      canRequest: true,
      request: { ...pendingListing.request!, outdated: true }
    };
    await openSharing(assistantDetail(4, { listingRequest: outdated }));
    expect(view().sharing?.draft.audience).toBe("owner");
    view().sharing!.onChange({ audience: "groups", groupIds: ["group-a"] });
    mocks.fetchAssistantDetail.mockResolvedValueOnce({ data: assistantDetail(4, { listingRequest: outdated }), ok: true });

    await expect(view().sharing!.onSave()).resolves.toBe(true);

    expect(mocks.publishAssistant).toHaveBeenCalledWith("assistant-1", { groupId: "group-a", scope: "group" });
    expect(mocks.withdrawAssistantListingRequest).not.toHaveBeenCalled();
    expect(mocks.requestAssistantListing).not.toHaveBeenCalled();
  });

  it("reports a failed Withdraw at the Everyone option", async () => {
    setViewer(false);
    await openSharing(assistantDetail(3, { listingRequest: pendingListing }));
    mocks.withdrawAssistantListingRequest.mockResolvedValue({
      code: "assistant_listing_request_conflict",
      message: "Conflict",
      ok: false,
      status: 409
    });

    view().sharing!.onWithdrawRequest();

    await vi.waitFor(() => expect(view().sharing?.withdrawing).toBe(false));
    expect(view().sharing).toMatchObject({
      error: null,
      failures: [{
        code: "assistant_listing_request_conflict",
        target: { kind: "everyone" },
        text: "The listing request changed in another session. Reopen Sharing and try again."
      }]
    });
  });

  it("leaves Featured unapplied when listing for everyone failed", async () => {
    setViewer(true);
    await openSharing(assistantDetail());
    view().sharing!.onChange({ audience: "everyone", featured: true, featuredOrder: 1 });
    mocks.publishAssistant.mockResolvedValueOnce({
      code: "assistant_skill_audience_mismatch",
      message: "Share every included Skill with this audience before publishing the Assistant.",
      ok: false,
      skills: ["Incident brief"],
      status: 409
    });
    mocks.fetchAssistantDetail.mockResolvedValueOnce({ data: assistantDetail(), ok: true });

    await expect(view().sharing!.onSave()).resolves.toBe(false);

    expect(mocks.setAssistantFeaturedOrder).not.toHaveBeenCalled();
    expect(view().sharing?.failures).toEqual([expect.objectContaining({
      skills: ["Incident brief"],
      target: { kind: "everyone" }
    })]);
    expect(view().sharing?.dirty).toBe(true);
  });

  it("shows the saved audience in the detail sheet it was opened from", async () => {
    setViewer(false);
    store().patch({ detail: { assistantId: "assistant-1", detail: assistantDetail(), error: null, requestId: 1, state: "ready" } });
    await openSharing(assistantDetail());
    view().sharing!.onChange({ audience: "groups", groupIds: ["group-a"] });
    const saved = assistantDetail(3, {
      audience: { everyone: false, groupNames: ["Group A"] },
      publications: [groupPublication("group-a")]
    });
    mocks.fetchAssistantDetail.mockResolvedValueOnce({ data: saved, ok: true });

    await view().sharing!.onSave();

    expect(store().sharing).toBeNull();
    expect(store().detail?.detail).toEqual(saved);
  });

  it("names the Assistant and the owner's resources, and copies its link", async () => {
    setViewer(false);
    mocks.fetchAssistantDetail.mockReturnValueOnce(new Promise(() => undefined));
    const input = assistantControllerInput();
    input.knowledgeBases = [{ available: true, id: "base-1", name: "Handbook" }];
    const actions = createAssistantLibraryActions(input);
    view(input, actions).gallery.onShare("assistant-1");

    const sharing = view(input, actions).sharing!;
    expect(sharing).toMatchObject({ name: "Code reviewer", state: "loading" });
    expect(sharing.names.knowledgeBases).toEqual([{ available: true, id: "base-1", name: "Handbook" }]);
    mocks.writeClipboardText.mockResolvedValue(undefined);
    await expect(sharing.onCopyLink()).resolves.toBe(true);
    expect(mocks.writeClipboardText).toHaveBeenCalledWith(`${window.location.origin}/assistant/assistant-1`);
  });

  it("refuses to share an Assistant the viewer does not own", async () => {
    setViewer(false);
    mocks.fetchAssistantDetail.mockResolvedValueOnce({ data: assistantDetail(3, { owned: false }), ok: true });

    view().gallery.onShare("assistant-1");

    await vi.waitFor(() => expect(view().sharing).toMatchObject({
      error: "Only the owner can share this assistant.",
      state: "error"
    }));
  });
});
