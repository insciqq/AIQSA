import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySettingsSection } from "./MemorySettingsSection";
import {
  resetMemorySettingsStoreForTest,
  useMemorySettingsStore
} from "./memorySettingsStore";
import { resetMemoryManagerStoreForTest } from "./memoryManagerStore";
import { resetMemoryOperationsStoreForTest } from "./memoryOperationsStore";
import { memorySettingsFixture } from "./memoryTestFixtures";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "@/lib/contracts/memory";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

describe("MemorySettingsSection", () => {
  const sectionProps = {
    accountId: "account-test",
    onOpenMemorySource: () => undefined
  };
  beforeEach(() => {
    resetMemorySettingsStoreForTest();
    resetMemoryManagerStoreForTest();
    resetMemoryOperationsStoreForTest();
  });
  afterEach(() => {
    cleanup();
    resetMemorySettingsStoreForTest();
    resetMemoryManagerStoreForTest();
    resetMemoryOperationsStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists RU/EN locale, submits independent gates, and accepts exact current destinations", async () => {
    let server = memorySettingsFixture({
      egress: {
        acceptedAt: null,
        acceptedUtilityEgressFingerprint: null,
        acceptedUtilityPolicyVersion: null,
        consentMode: "PER_USER",
        currentUtilityEgressFingerprint: "current-destination-fingerprint-00000001",
        reviewRequired: true
      }
    }, "RU");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path !== "/api/me/memory/settings") throw new Error(`unexpected request: ${path}`);
      if (init?.method === "GET") return json(server);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.memoryUiLocale === "EN") {
        server = memorySettingsFixture({
          capabilities: server.capabilities,
          egress: server.egress,
          settings: {
            ...server.settings,
            memoryUiLocale: "EN",
            settingsRevision: server.settings.settingsRevision + 1
          }
        }, "EN");
      } else if (typeof body.useMemoryFacts === "boolean") {
        server = memorySettingsFixture({
          capabilities: server.capabilities,
          egress: server.egress,
          settings: {
            ...server.settings,
            memoryRevision: server.settings.memoryRevision + 1,
            settingsRevision: server.settings.settingsRevision + 1,
            useMemoryFacts: body.useMemoryFacts
          }
        }, "EN");
      } else {
        server = memorySettingsFixture({
          capabilities: server.capabilities,
          egress: {
            ...server.egress,
            acceptedAt: "2026-08-10T10:00:00.000Z",
            acceptedUtilityEgressFingerprint: server.egress.currentUtilityEgressFingerprint,
            acceptedUtilityPolicyVersion: server.egress.currentUtilityPolicyVersion,
            reviewRequired: false
          },
          settings: {
            ...server.settings,
            memoryConsentRevision: server.settings.memoryConsentRevision + 1,
            settingsRevision: server.settings.settingsRevision + 1
          }
        }, "EN");
      }
      return json(server);
    }));

    render(<MemorySettingsSection {...sectionProps} />);

    expect(await screen.findByRole("heading", { name: "Память" })).toBeVisible();
    expect(screen.getByRole("switch", { name: "Использовать факты из памяти" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Текущий отпечаток назначений")).toBeVisible();
    expect(screen.getByText("current-destination-fingerprint-00000001")).toBeVisible();
    expect(screen.getByText("Перед продолжением внешней обработки Памяти требуется проверка.")).toBeVisible();

    fireEvent.click(screen.getByRole("radio", { name: "English" }));
    expect(await screen.findByRole("heading", { name: "Memory" })).toBeVisible();
    fireEvent.click(screen.getByRole("switch", { name: "Use memory facts" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Use memory facts" })).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(screen.getByRole("button", { name: "Accept current destinations" }));
    await waitFor(() => expect(screen.getByText("Current Memory destinations accepted.")).toBeVisible());

    expect(bodies[0]).toEqual({ expectedSettingsRevision: 12, memoryUiLocale: "EN" });
    expect(bodies[1]).toMatchObject({
      expectedMemoryRevision: 8,
      expectedSettingsRevision: 13,
      useMemoryFacts: true
    });
    expect(bodies[2]).toMatchObject({
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
      currentUtilityEgressFingerprint: "current-destination-fingerprint-00000001"
    });
  });

  it("shows fail-closed capabilities without hiding independently stored preferences", async () => {
    const server = memorySettingsFixture({
      capabilities: {
        automaticLearning: false,
        explicitMemory: false,
        historyRecall: false,
        russianQualified: false,
        temporaryChats: false
      },
      settings: {
        learnAutomatically: true,
        referenceChatHistory: true,
        useMemoryFacts: true
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(server)));

    render(<MemorySettingsSection {...sectionProps} />);

    expect(await screen.findByRole("heading", { name: "Memory" })).toBeVisible();
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(3);
    for (const control of switches) {
      expect(control).toHaveAttribute("aria-checked", "true");
      expect(control).toBeEnabled();
    }
    expect(screen.getAllByText(/Preference is stored; this capability is not active/u)).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Manage Memories" })).toBeDisabled();
    const capabilities = screen.getByRole("heading", { name: "Current capabilities" }).parentElement!;
    expect(within(capabilities).getAllByText("Unavailable")).toHaveLength(4);
  });

  it("shows passive lexical indexing progress in the selected RU/EN locale", async () => {
    let server = memorySettingsFixture({
      historyIndexing: {
        completedChats: 2,
        state: "INDEXING",
        totalChats: 5
      },
      settings: { referenceChatHistory: true }
    }, "RU");
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        server = memorySettingsFixture({
          historyIndexing: server.historyIndexing,
          settings: {
            ...server.settings,
            memoryUiLocale: "EN",
            settingsRevision: server.settings.settingsRevision + 1
          }
        }, "EN");
      }
      return json(server);
    }));

    render(<MemorySettingsSection {...sectionProps} />);

    expect(await screen.findByText("Индексируется 2 из 5 чатов")).toHaveAttribute(
      "role",
      "status"
    );
    fireEvent.click(screen.getByRole("radio", { name: "English" }));
    expect(await screen.findByText("Indexing 2 of 5 chats")).toHaveAttribute(
      "role",
      "status"
    );
  });

  it("shows only passive administrator-owned destination status in ADMIN mode", async () => {
    const server = memorySettingsFixture({
      egress: {
        acceptedAt: null,
        acceptedUtilityEgressFingerprint: null,
        acceptedUtilityPolicyVersion: null,
        consentMode: "ADMIN",
        reviewRequired: false
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(server)));

    render(<MemorySettingsSection {...sectionProps} />);

    expect(await screen.findByText(
      "Destination trust and renewal are managed by an administrator. No action is required from you."
    )).toBeVisible();
    expect(screen.queryByRole("button", { name: "Accept current destinations" }))
      .not.toBeInTheDocument();
    expect(screen.queryByText("Current destination fingerprint")).not.toBeInTheDocument();
  });

  it("reports mutation busy state to the Settings owner", async () => {
    const server = memorySettingsFixture();
    let resolvePatch!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Promise<Response>((resolve) => { resolvePatch = resolve; });
      }
      return json(server);
    }));
    const onBusyChange = vi.fn();
    render(<MemorySettingsSection {...sectionProps} onBusyChange={onBusyChange} />);
    await screen.findByRole("heading", { name: "Memory" });

    fireEvent.click(screen.getByRole("switch", { name: "Use memory facts" }));
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    resolvePatch(json(memorySettingsFixture({ settings: { useMemoryFacts: true } })));
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });

  it("enters and returns from the history-operations task with deterministic focus", async () => {
    const server = memorySettingsFixture({ settings: { referenceChatHistory: true } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(server)));
    render(<MemorySettingsSection {...sectionProps} />);

    const entry = await screen.findByRole("button", { name: "History operations" });
    const scrollOwner = screen.getByTestId("settings-memory-scroll");
    scrollOwner.scrollTop = 240;
    fireEvent.click(entry);
    const heading = screen.getByRole("heading", { name: "History operations" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(scrollOwner.scrollTop).toBe(0);
    expect(scrollOwner.querySelectorAll(".overflow-y-auto"))
      .toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Back to Memory settings" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "History operations" })).toHaveFocus());
    expect(scrollOwner.scrollTop).toBe(240);
    expect(screen.getByRole("heading", { name: "Memory" })).toBeVisible();
  });
});
