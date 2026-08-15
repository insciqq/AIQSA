import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "./MemoryWorkspace";
import { resetMemoryHealthStoreForTest } from "./memoryHealthStore";
import { resetMemoryManagerStoreForTest } from "./memoryManagerStore";
import { resetMemoryOperationsStoreForTest } from "./memoryOperationsStore";
import { resetMemorySettingsStoreForTest } from "./memorySettingsStore";
import { memoryHealthFixture, memorySettingsFixture } from "./memoryTestFixtures";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

describe("MemoryWorkspace", () => {
  beforeEach(() => {
    resetMemoryHealthStoreForTest();
    resetMemoryManagerStoreForTest();
    resetMemoryOperationsStoreForTest();
    resetMemorySettingsStoreForTest();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/me/memory/health"
        ? json({ health: memoryHealthFixture() })
        : json(memorySettingsFixture())));
  });

  afterEach(() => {
    cleanup();
    resetMemoryHealthStoreForTest();
    resetMemoryManagerStoreForTest();
    resetMemoryOperationsStoreForTest();
    resetMemorySettingsStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("owns a full-screen English workspace and returns directly to chat", async () => {
    const onClose = vi.fn();
    render(
      <MemoryWorkspace
        accountId="account-test"
        onClose={onClose}
        onOpenMemorySource={vi.fn()}
      />
    );

    const workspace = screen.getByTestId("memory-workspace");
    expect(workspace).toHaveClass("fixed", "inset-0", "h-[100dvh]", "w-full");
    expect(workspace).toHaveAttribute("aria-modal", "true");
    expect(await screen.findByRole("heading", { name: "Memory", level: 3 })).toBeVisible();
    expect(screen.queryByText("Память")).not.toBeInTheDocument();
    expect(screen.queryByText("Memory language")).not.toBeInTheDocument();

    const back = screen.getByRole("button", { name: "Back to chat" });
    await waitFor(() => expect(back).toHaveFocus());
    fireEvent.click(back);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps source-navigation feedback inside the Memory workspace", async () => {
    const onDismissNotice = vi.fn();
    render(
      <MemoryWorkspace
        accountId="account-test"
        notice={{ kind: "error", text: "The Memory source is unavailable." }}
        onClose={vi.fn()}
        onDismissNotice={onDismissNotice}
        onOpenMemorySource={vi.fn()}
      />
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Memory source is unavailable."
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(onDismissNotice).toHaveBeenCalledOnce();
  });
});
