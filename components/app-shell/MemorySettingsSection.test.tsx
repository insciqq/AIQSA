import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySettingsSection } from "./MemorySettingsSection";
import { memoryHealthFixture, memorySettingsFixture } from "@/tests/support/memoryFixtures";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "@/lib/contracts/memory";
import { resetMemoryHealthStoreForTest, resetMemoryManagerStoreForTest, resetMemoryOperationsStoreForTest, resetMemorySettingsStoreForTest } from "@/tests/support/appShellStores";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

function withHealth(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  health = memoryHealthFixture()
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === "/api/me/memory/health"
      ? json({ health })
      : handler(input, init));
}

describe("MemorySettingsSection", () => {
  const sectionProps = {
    accountId: "account-test",
    onOpenMemorySource: () => undefined
  };
  beforeEach(() => {
    resetMemoryHealthStoreForTest();
    resetMemorySettingsStoreForTest();
    resetMemoryManagerStoreForTest();
    resetMemoryOperationsStoreForTest();
  });
  afterEach(() => {
    cleanup();
    resetMemoryHealthStoreForTest();
    resetMemorySettingsStoreForTest();
    resetMemoryManagerStoreForTest();
    resetMemoryOperationsStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("presents English and submits independent gates", async () => {
    let server = memorySettingsFixture({
      egress: {
        acceptedAt: null,
        acceptedUtilityEgressFingerprint: null,
        acceptedUtilityPolicyVersion: null,
        consentMode: "PER_USER",
        currentUtilityEgressFingerprint: "current-destination-fingerprint-00000001",
        reviewRequired: true
      }
    });
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", withHealth(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path !== "/api/me/memory/settings") throw new Error(`unexpected request: ${path}`);
      if (init?.method === "GET") return json(server);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (typeof body.useMemoryFacts === "boolean") {
        server = memorySettingsFixture({
          capabilities: server.capabilities,
          egress: server.egress,
          settings: {
            ...server.settings,
            memoryRevision: server.settings.memoryRevision + 1,
            settingsRevision: server.settings.settingsRevision + 1,
            useMemoryFacts: body.useMemoryFacts
          }
        });
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
        });
      }
      return json(server);
    }));

    render(<MemorySettingsSection {...sectionProps} />);

    expect(await screen.findByRole("heading", { name: "Memory" })).toBeVisible();
    expect(screen.getByRole("switch", { name: "Use memory facts" })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("radio", { name: "English" })).not.toBeInTheDocument();
    expect(screen.queryByText("Memory language")).not.toBeInTheDocument();
    expect(screen.getByText("current-destination-fingerprint-00000001")).not.toBeVisible();
    fireEvent.click(screen.getByText("Advanced", { exact: true }));
    expect(screen.getByText("Current destination fingerprint")).toBeVisible();
    expect(screen.getByText("current-destination-fingerprint-00000001")).toBeVisible();
    expect(screen.getByText(
      "Review the current destinations before any affected external Memory processing continues."
    )).toBeVisible();

    fireEvent.click(screen.getByRole("switch", { name: "Use memory facts" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Use memory facts" })).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(screen.getByRole("button", { name: "Accept current destinations" }));
    await waitFor(() => expect(screen.getByText("Current Memory destinations accepted.")).toBeVisible());

    expect(bodies[0]).toMatchObject({
      expectedMemoryRevision: 8,
      expectedSettingsRevision: 12,
      useMemoryFacts: true
    });
    expect(bodies[1]).toMatchObject({
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
        temporaryChats: false
      },
      settings: {
        learnAutomatically: true,
        referenceChatHistory: true,
        useMemoryFacts: true
      }
    });
    vi.stubGlobal("fetch", withHealth(async () => json(server)));

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
    fireEvent.click(screen.getByText("Advanced", { exact: true }));
    const capabilities = screen.getByText("Current capabilities").parentElement!;
    expect(within(capabilities).getAllByText("Unavailable")).toHaveLength(3);
  });

  it("shows passive lexical indexing progress in English", async () => {
    const server = memorySettingsFixture({
      historyIndexing: {
        completedChats: 2,
        state: "INDEXING",
        totalChats: 5
      },
      settings: { referenceChatHistory: true }
    });
    vi.stubGlobal("fetch", withHealth(async () => json(server)));

    render(<MemorySettingsSection {...sectionProps} />);

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
    vi.stubGlobal("fetch", withHealth(async () => json(server)));

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
    vi.stubGlobal("fetch", withHealth(async (_input: RequestInfo | URL, init?: RequestInit) => {
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

  it("enters and returns from the Memory-operations task with deterministic focus", async () => {
    const server = memorySettingsFixture({ settings: { referenceChatHistory: true } });
    vi.stubGlobal("fetch", withHealth(async () => json(server)));
    render(<MemorySettingsSection {...sectionProps} />);

    const entry = await screen.findByRole("button", { name: "Memory operations" });
    const scrollOwner = screen.getByTestId("settings-memory-scroll");
    scrollOwner.scrollTop = 240;
    fireEvent.click(entry);
    const heading = screen.getByRole("heading", { name: "Memory operations" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(scrollOwner.scrollTop).toBe(0);
    expect(scrollOwner.querySelectorAll(".overflow-y-auto"))
      .toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Back to Memory settings" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Memory operations" })).toHaveFocus());
    expect(scrollOwner.scrollTop).toBe(240);
    expect(screen.getByRole("heading", { name: "Memory" })).toBeVisible();
  });
});
