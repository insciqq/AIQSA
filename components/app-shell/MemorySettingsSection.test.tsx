import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySettingsSection } from "./MemorySettingsSection";
import { memoryConsumerSettingsFixture } from "@/tests/support/memoryFixtures";
import {
  resetMemoryManagerStoreForTest,
  resetMemorySettingsStoreForTest
} from "@/tests/support/appShellStores";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

describe("MemorySettingsSection", () => {
  const sectionProps = {
    accountId: "account-test"
  };

  beforeEach(() => {
    resetMemorySettingsStoreForTest();
    resetMemoryManagerStoreForTest();
  });

  afterEach(() => {
    cleanup();
    resetMemorySettingsStoreForTest();
    resetMemoryManagerStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders only the five consumer toggles and hides control-plane details", async () => {
    const server = memoryConsumerSettingsFixture({
      settings: {
        decayEnabled: true,
        learnAutomatically: true,
        referenceChatHistory: true,
        synthesisEnabled: true,
        useMemoryFacts: true
      },
      status: "ON"
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/me/memory/settings");
      return json(server);
    }));

    render(<MemorySettingsSection {...sectionProps} />);

    expect(await screen.findByRole("heading", { name: "Memory" })).toBeVisible();
    expect(screen.getAllByRole("switch")).toHaveLength(5);
    expect(screen.getByRole("switch", { name: "Memory" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Search past chats" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Learn automatically" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Discover patterns" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Prioritize useful memories" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Temporary Chat does not use or create memory.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Manage memory" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Reset personal memory" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Memory options" }));
    expect(screen.getByRole("menuitem", { name: "Reset personal memory" })).toBeVisible();
    expect(screen.queryByText(/destination|fingerprint|embedding|reranker|index|generation|job|queue/iu)).not.toBeInTheDocument();
  });

  it.each([
    ["ON", "On"],
    ["PREPARING", "Preparing"],
    ["UNAVAILABLE", "Temporarily unavailable"],
    ["NEEDS_ADMIN_SETUP", "Needs administrator setup"],
    ["PAUSED", "Paused"]
  ] as const)("renders the exact Settings consumer status for %s", async (status, label) => {
    vi.stubGlobal("fetch", vi.fn(async () => json(memoryConsumerSettingsFixture({ status }))));

    render(<MemorySettingsSection {...sectionProps} />);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(label));
  });

  it("keeps loading and error distinct and retries the settings request", async () => {
    let resolveFirst!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(json(memoryConsumerSettingsFixture({ status: "ON" })));
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<MemorySettingsSection {...sectionProps} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Memory settings…");
    resolveFirst(json({ error: "unavailable" }, 503));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Memory settings could not be loaded."
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Memory" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("submits each preference independently and keeps stored preferences visible when unavailable", async () => {
    const server = memoryConsumerSettingsFixture({
      capabilities: {
        automaticLearningAvailable: false,
        decayAvailable: false,
        managementAvailable: true,
        naturalLanguageActionsAvailable: false,
        pastChatIndexingAvailable: false,
        retrievalAvailable: false,
        synthesisAvailable: false
      },
      settings: {
        decayEnabled: true,
        learnAutomatically: true,
        referenceChatHistory: true,
        synthesisEnabled: true,
        useMemoryFacts: true
      },
      status: "UNAVAILABLE"
    });
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return json(server);
      }
      return json(server);
    }));

    render(<MemorySettingsSection {...sectionProps} />);

    expect(await screen.findByRole("switch", { name: "Memory" })).toBeEnabled();
    expect(screen.getAllByText("Temporarily unavailable")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Manage memory" })).toBeEnabled();
    fireEvent.click(screen.getByRole("switch", { name: "Memory" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    fireEvent.click(screen.getByRole("switch", { name: "Search past chats" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    fireEvent.click(screen.getByRole("switch", { name: "Learn automatically" }));
    await waitFor(() => expect(bodies).toHaveLength(3));
    fireEvent.click(screen.getByRole("switch", { name: "Discover patterns" }));
    await waitFor(() => expect(bodies).toHaveLength(4));
    fireEvent.click(screen.getByRole("switch", { name: "Prioritize useful memories" }));
    await waitFor(() => expect(bodies).toHaveLength(5));
    expect(bodies).toEqual(expect.arrayContaining([
      expect.objectContaining({ useMemoryFacts: false }),
      expect.objectContaining({ referenceChatHistory: false }),
      expect.objectContaining({ learnAutomatically: false }),
      expect.objectContaining({ synthesisEnabled: false }),
      expect.objectContaining({ decayEnabled: false })
    ]));
  });

  it.each([
    ["naturalLanguageActionsAvailable", "Memory"],
    ["retrievalAvailable", "Memory"],
    ["automaticLearningAvailable", "Learn automatically"],
    ["pastChatIndexingAvailable", "Search past chats"],
    ["synthesisAvailable", "Discover patterns"],
    ["decayAvailable", "Prioritize useful memories"]
  ] as const)("shows a feature-specific unavailable state for %s", async (
    capability,
    label
  ) => {
    const server = memoryConsumerSettingsFixture({
      capabilities: { [capability]: false },
      settings: {
        decayEnabled: true,
        learnAutomatically: true,
        referenceChatHistory: true,
        synthesisEnabled: true,
        useMemoryFacts: true
      },
      status: "UNAVAILABLE"
    });
    vi.stubGlobal("fetch", vi.fn(async () => json(server)));

    render(<MemorySettingsSection {...sectionProps} />);

    const toggle = await screen.findByRole("switch", { name: label });
    const describedBy = toggle.getAttribute("aria-describedby")?.split(" ") ?? [];
    const status = document.getElementById(describedBy.at(-1) ?? "");
    expect(status).toHaveTextContent("Temporarily unavailable");
    expect(toggle).toBeEnabled();
    expect(screen.getByRole("button", { name: "Manage memory" })).toBeEnabled();
  });

  it("owns focus, Escape, and confirmation before starting personal-memory reset", async () => {
    const settings = memoryConsumerSettingsFixture({
      settings: { learnAutomatically: true, referenceChatHistory: true, useMemoryFacts: true },
      status: "ON"
    });
    let settingsReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/me/memory/settings") {
        settingsReads += 1;
        return json(settings);
      }
      if (path === "/api/me/memory/reset") return json({ status: "IN_PROGRESS" }, 202);
      throw new Error(`unexpected request: ${path}`);
    }));

    render(<MemorySettingsSection {...sectionProps} />);
    const options = await screen.findByRole("button", { name: "Memory options" });
    fireEvent.click(options);
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset personal memory" }));
    const dialog = screen.getByRole("dialog", { name: "Reset personal memory?" });
    expect(dialog).toBeVisible();
    expect(screen.getByRole("heading", { name: "Reset personal memory?" })).toBeVisible();
    const cancel = screen.getByRole("button", { name: "Keep Memory" });
    const confirm = screen.getByRole("button", { name: "Reset now" });
    await waitFor(() => expect(cancel).toHaveFocus());
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(cancel).toHaveFocus();
    expect(settingsReads).toBe(1);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Reset personal memory?" }))
      .not.toBeInTheDocument();
    expect(options).toHaveFocus();

    fireEvent.click(options);
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset personal memory" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset now" }));
    await waitFor(() => expect(screen.getByText("Memory is off. Reset cleanup is continuing in the background.")).toBeVisible());
    expect(settingsReads).toBeGreaterThanOrEqual(2);
  });

  it("reports setting mutations to the owning workspace", async () => {
    const server = memoryConsumerSettingsFixture();
    let resolvePatch!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Promise<Response>((resolve) => { resolvePatch = resolve; });
      }
      return json(server);
    }));
    const onBusyChange = vi.fn();
    render(<MemorySettingsSection {...sectionProps} onBusyChange={onBusyChange} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Memory" }));
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    resolvePatch(json(server));
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });
});
