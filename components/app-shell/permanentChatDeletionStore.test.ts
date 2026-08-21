import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "@/lib/contracts/memoryClient";
import { memoryConsumerSettingsFixture } from "@/tests/support/memoryFixtures";
import {
  resetMemorySettingsStoreForTest,
  resetPermanentChatDeletionStoreForTest
} from "@/tests/support/appShellStores";
import { useMemorySettingsStore } from "./memorySettingsStore";
import {
  activatePermanentChatDeletionAccount,
  confirmPermanentChatDeletion,
  deactivatePermanentChatDeletionAccount,
  openPermanentChatDeletion,
  setPermanentChatDeletionOriginForget,
  usePermanentChatDeletionStore
} from "./permanentChatDeletionStore";

beforeEach(() => {
  resetPermanentChatDeletionStoreForTest();
  resetMemorySettingsStoreForTest();
  window.sessionStorage.clear();
  useMemorySettingsStore.setState({
    data: memoryConsumerSettingsFixture({
      capabilities: { permanentChatDeletion: true }
    }),
    error: null,
    loadState: "ready"
  });
});

afterEach(() => {
  resetPermanentChatDeletionStoreForTest();
  resetMemorySettingsStoreForTest();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("permanent chat deletion store", () => {
  it("sends one safe confirmation and persists only a chat-keyed reference", async () => {
    const reconciled = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/status")) return Response.json({ status: "IN_PROGRESS" });
      expect(path).toBe("/api/chats/chat-1/delete-permanently");
      expect(init?.method).toBe("POST");
      return Response.json({ status: "IN_PROGRESS" });
    });
    vi.stubGlobal("fetch", fetchMock);

    window.sessionStorage.setItem(
      "aiqsa:chat-permanent-deletion:v1:account-a",
      JSON.stringify({ chatId: "chat-1", deletionId: "legacy-private", version: 1 })
    );
    await activatePermanentChatDeletionAccount("account-a", reconciled);
    expect(window.sessionStorage.getItem(
      "aiqsa:chat-permanent-deletion:v1:account-a"
    )).toBeNull();
    openPermanentChatDeletion({
      chatId: "chat-1",
      location: "WORKSPACE",
      title: "Private chat"
    });
    setPermanentChatDeletionOriginForget(true);
    await confirmPermanentChatDeletion();

    expect(fetchMock).toHaveBeenCalledOnce();
    const confirmation = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body)
    ) as Record<string, unknown>;
    expect(confirmation).toEqual({
      alsoForgetOriginMemories: true,
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      requestId: expect.any(String)
    });
    expect(Object.keys(confirmation).sort()).toEqual([
      "alsoForgetOriginMemories",
      "confirmationCopyVersion",
      "requestId"
    ]);
    expect(reconciled).toHaveBeenCalledWith("chat-1");
    expect(usePermanentChatDeletionStore.getState()).toMatchObject({
      reference: { chatId: "chat-1" },
      status: { status: "IN_PROGRESS" },
      statusOpen: true,
      target: null
    });
    expect(window.sessionStorage.getItem(
      "aiqsa:chat-permanent-deletion:v2:account-a"
    )).toBe(JSON.stringify({ chatId: "chat-1", version: 2 }));

    deactivatePermanentChatDeletionAccount("account-a");
    await activatePermanentChatDeletionAccount("account-a");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "/api/chats/chat-1/delete-permanently/status"
    );
    expect(usePermanentChatDeletionStore.getState().status)
      .toEqual({ status: "IN_PROGRESS" });
  });

  it("leaves snapshot authority on the server and surfaces only a friendly error", async () => {
    const fetchMock = vi.fn(async () => Response.json(
      { error: "CHANGED" },
      { status: 409 }
    ));
    vi.stubGlobal("fetch", fetchMock);
    await activatePermanentChatDeletionAccount("account-a");
    openPermanentChatDeletion({
      chatId: "chat-1",
      location: "WORKSPACE",
      title: "Private chat"
    });

    await expect(confirmPermanentChatDeletion()).rejects.toMatchObject({
      reason: "CHANGED"
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(usePermanentChatDeletionStore.getState()).toMatchObject({
      busy: false,
      confirmationError: "CHANGED",
      target: { chatId: "chat-1" }
    });
  });

  it("recovers a lost confirmation response from chat-keyed status", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("network response lost"))
      .mockResolvedValueOnce(Response.json({ status: "IN_PROGRESS" }));
    vi.stubGlobal("fetch", fetchMock);
    await activatePermanentChatDeletionAccount("account-a");
    openPermanentChatDeletion({
      chatId: "chat-1",
      location: "WORKSPACE",
      title: "Private chat"
    });

    await expect(confirmPermanentChatDeletion()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0]))
      .toBe("/api/chats/chat-1/delete-permanently/status");
    expect(usePermanentChatDeletionStore.getState()).toMatchObject({
      confirmationError: null,
      reference: { chatId: "chat-1" },
      status: { status: "IN_PROGRESS" },
      statusOpen: true,
      target: null
    });
  });

  it("keeps the workflow unavailable when the server capability is dark", async () => {
    useMemorySettingsStore.setState({
      data: memoryConsumerSettingsFixture({
        capabilities: { permanentChatDeletion: false }
      })
    });
    await activatePermanentChatDeletionAccount("account-a");
    openPermanentChatDeletion({
      chatId: "chat-1",
      location: "WORKSPACE",
      title: "Private chat"
    });
    expect(usePermanentChatDeletionStore.getState().target).toBeNull();
  });
});
