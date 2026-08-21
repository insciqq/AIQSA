import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryActionFeedback } from "@/lib/contracts/memoryClient";
import { MemoryActionConfirmationV2 } from "./MemoryActionConfirmationV2";

type MemoryActionResultItem = NonNullable<MemoryActionFeedback["items"]>[number];

const resultItem = (overrides: Partial<MemoryActionResultItem> = {}): MemoryActionResultItem => ({
  category: "preference",
  createdAt: "2026-08-11T08:00:00.000Z",
  memoryRef: "mr1.server-only-memory-reference",
  provenance: "SAVED",
  sensitivity: "NORMAL",
  statement: "I prefer concise answers.",
  ...overrides
});

describe("client-safe Memory action feedback", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("offers opaque-ref Edit and Forget actions for committed Save/Update results", () => {
    const { rerender } = render(
      <MemoryActionConfirmationV2
        action={{
          memoryRef: "mr1.save-reference",
          operation: "SAVE",
          statement: "I prefer concise answers.",
          status: "COMMITTED"
        }}
      />
    );

    expect(screen.getByText("Memory saved.")).toBeVisible();
    expect(screen.getByText("Done")).toBeVisible();
    expect(screen.getByTestId("memory-action-statement")).toHaveTextContent(
      "I prefer concise answers."
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Forget" })).toBeVisible();
    expect(screen.queryByText("mr1.save-reference")).not.toBeInTheDocument();

    rerender(
      <MemoryActionConfirmationV2
        action={{
          memoryRef: "mr1.update-reference",
          operation: "UPDATE",
          statement: "I prefer short answers.",
          status: "COMMITTED"
        }}
      />
    );
    expect(screen.getByText("Memory updated.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();

    rerender(
      <MemoryActionConfirmationV2
        action={{
          operation: "FORGET",
          status: "COMMITTED"
        }}
      />
    );
    expect(screen.getByText("Forgotten.")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("clears local edit state when a later action replaces the result", () => {
    const { rerender } = render(
      <MemoryActionConfirmationV2
        action={{
          memoryRef: "mr1.first-reference",
          operation: "SAVE",
          statement: "The first statement.",
          status: "COMMITTED"
        }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Correct this memory" }), {
      target: { value: "Unsaved local text" }
    });

    rerender(
      <MemoryActionConfirmationV2
        action={{
          memoryRef: "mr1.second-reference",
          operation: "UPDATE",
          statement: "The replacement statement.",
          status: "COMMITTED"
        }}
      />
    );

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByTestId("memory-action-statement"))
      .toHaveTextContent("The replacement statement.");
    expect(screen.getByRole("region", { name: "Memory updated." })).toBeVisible();
  });

  it("commits Edit and Forget controls through the opaque result reference", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ status: "COMMITTED" }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(
      <MemoryActionConfirmationV2
        action={{
          memoryRef: "mr1.committed-edit-ref",
          operation: "SAVE",
          statement: "The original statement.",
          status: "COMMITTED"
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Correct this memory" }), {
      target: { value: "The corrected statement." }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)))
      .toMatchObject({
        action: "CORRECT",
        memoryRef: "mr1.committed-edit-ref",
        statement: "The corrected statement."
      });

    rerender(
      <MemoryActionConfirmationV2
        action={{
          memoryRef: "mr1.committed-forget-ref",
          operation: "UPDATE",
          statement: "Another statement.",
          status: "COMMITTED"
        }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)))
      .toMatchObject({
        action: "FORGET",
        memoryRef: "mr1.committed-forget-ref"
      });
  });

  it("renders complete List and Search items as read-only, friendly cards", () => {
    const items = [
      resultItem(),
      resultItem({
        category: "sensitive",
        createdAt: "2026-08-10T08:00:00.000Z",
        memoryRef: "mr1.second-reference",
        provenance: "LEARNED",
        sensitivity: "SENSITIVE",
        statement: "I am preparing a release plan."
      })
    ];
    const { rerender } = render(
      <MemoryActionConfirmationV2 action={{ items, operation: "LIST", status: "COMPLETE" }} />
    );

    expect(screen.getByText("Saved memories")).toBeVisible();
    expect(screen.getByText("I prefer concise answers.")).toBeVisible();
    expect(screen.getByText("Saved by you")).toBeVisible();
    expect(screen.queryByText("Sensitive", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("Other")).toBeVisible();
    expect(screen.getByText("Learned from chat")).toBeVisible();
    expect(screen.queryByText(/mr1\./u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    rerender(
      <MemoryActionConfirmationV2 action={{ items: [], operation: "SEARCH", status: "COMPLETE" }} />
    );
    expect(screen.getByText("Memory search results")).toBeVisible();
    expect(screen.getByText("No saved memories match this search.")).toBeVisible();
  });

  it("commits only the explicitly selected opaque candidate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ status: "COMMITTED" }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryActionConfirmationV2
        action={{
          candidates: [
            resultItem({ statement: "I prefer concise answers." }),
            resultItem({
              memoryRef: "mr1.second-candidate-reference",
              statement: "I prefer detailed answers."
            })
          ],
          operation: "UPDATE",
          statement: "I prefer short answers.",
          status: "AMBIGUOUS"
        }}
      />
    );

    expect(screen.getByText(/Several memories match\./u)).toBeVisible();
    expect(screen.getByText(/No change was made/u)).toBeVisible();
    expect(screen.getAllByTestId("memory-action-candidate")).toHaveLength(2);
    const actions = screen.getAllByRole("button", { name: "Update this memory" });
    expect(actions).toHaveLength(2);
    expect(screen.queryByText(/mr1\./u)).not.toBeInTheDocument();

    fireEvent.click(actions[1]!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/me/memory/source-actions");
    expect(JSON.parse(String(init.body))).toMatchObject({
      action: "CORRECT",
      memoryRef: "mr1.second-candidate-reference",
      statement: "I prefer short answers."
    });
    expect(await screen.findByText("Memory updated.")).toBeVisible();
  });

  it("forgets only the explicitly selected ambiguous candidate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ status: "COMMITTED" }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryActionConfirmationV2
        action={{
          candidates: [
            resultItem({ memoryRef: "mr1.keep-candidate" }),
            resultItem({
              memoryRef: "mr1.forget-candidate",
              statement: "I prefer detailed answers."
            })
          ],
          operation: "FORGET",
          status: "AMBIGUOUS"
        }}
      />
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Forget this memory" })[1]!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      action: "FORGET",
      memoryRef: "mr1.forget-candidate"
    });
    expect(body).not.toHaveProperty("statement");
  });

  it("opens Memory settings for reset confirmation and handles non-actions plainly", () => {
    const onOpenMemorySettings = vi.fn();
    const { rerender } = render(
      <MemoryActionConfirmationV2
        action={{ operation: "RESET", status: "CONFIRMATION_REQUIRED" }}
        onOpenMemorySettings={onOpenMemorySettings}
      />
    );
    expect(screen.getByText(/Reset personal memory needs your confirmation/u)).toBeVisible();
    expect(screen.getByText("Confirmation needed")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Review reset" }));
    expect(onOpenMemorySettings).toHaveBeenCalledOnce();

    rerender(
      <MemoryActionConfirmationV2
        action={{
          operation: "SAVE",
          statement: "A secret token",
          status: "REJECTED"
        }}
      />
    );
    expect(screen.getByText("Memory action was not applied.")).toBeVisible();
    expect(screen.queryByTestId("memory-action-statement")).not.toBeInTheDocument();
    expect(screen.getByText("Not applied")).toBeVisible();

    rerender(
      <MemoryActionConfirmationV2
        action={{
          operation: "SAVE",
          statement: "Use compact replies in this chat.",
          status: "THIS_CHAT_ONLY"
        }}
      />
    );
    expect(screen.getByText("Saved for this chat only.")).toBeVisible();
    expect(screen.getByText("This chat only")).toBeVisible();
  });
});
