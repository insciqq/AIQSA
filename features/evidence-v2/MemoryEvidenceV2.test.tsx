import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { memorySummaryFixture } from "@/components/app-shell/memoryTestFixtures";
import type { MemoryReceipt } from "@/lib/contracts/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryActionConfirmationV2, MemoryEvidenceV2 } from "./MemoryEvidenceV2";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

const receipt: MemoryReceipt = {
  degradationCode: null,
  itemCount: 1,
  items: [{
    factId: "fact-automatic-1",
    feedbackState: "AVAILABLE",
    includedText: "The user prefers short answers.",
    itemType: "FACT_VERSION",
    lifecycleState: "CURRENT",
    ordinal: 0,
    runId: "run-1",
    runItemId: "run-item-1",
    scopeType: "GLOBAL_USER",
    selectionReason: "automatic_semantic_relevance",
    sourceChatId: "chat-source-1",
    sourceMessageIds: ["message-source-1"],
    sourceMode: "AUTOMATIC",
    versionId: "version-automatic-1"
  }],
  outcome: "USED",
  summary: "memory_receipt:used:1"
};

describe("MemoryEvidenceV2", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps exact automatic evidence collapsed, then commits and retracts feedback", async () => {
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push(body);
      return writes.length === 1
        ? json({
            createdAt: "2026-08-11T08:00:00.000Z",
            feedbackId: "feedback-1",
            feedbackType: "INCORRECT",
            retractedFeedbackId: null,
            targetVersionId: "version-automatic-1"
          }, 201)
        : json({
            createdAt: "2026-08-11T08:01:00.000Z",
            feedbackId: "feedback-retract-1",
            feedbackType: "RETRACT",
            retractedFeedbackId: "feedback-1",
            targetVersionId: "version-automatic-1"
          }, 201);
    }));
    render(<MemoryEvidenceV2 locale="EN" receipt={receipt} />);

    expect(screen.queryByText("The user prefers short answers.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Memory.*memory used/u }));
    expect(screen.getByText("The user prefers short answers.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "This is incorrect" }));
    expect(await screen.findByText("Marked incorrect")).toBeVisible();
    expect(writes[0]).toMatchObject({
      expectedVersionId: "version-automatic-1",
      feedbackType: "INCORRECT",
      modelRunId: "run-1",
      modelRunMemoryItemId: "run-item-1"
    });

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "This is incorrect" }))
      .toBeEnabled());
    expect(writes[1]).toMatchObject({
      expectedVersionId: "version-automatic-1",
      feedbackType: "RETRACT",
      retractsFeedbackId: "feedback-1"
    });
  });

  it("supports exact Save edit, Undo, and bounded Restore", async () => {
    const requests: Array<{ body: Record<string, unknown>; method: string; path: string }> = [];
    let authorizationOrdinal = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ body, method: init?.method ?? "GET", path });
      if (path === "/api/me/memory/mutation-authorizations") {
        authorizationOrdinal += 1;
        return json({
          expiresAt: "2099-08-11T08:05:00.000Z",
          mutationAuthorizationId: `authorization-${authorizationOrdinal}`
        }, 201);
      }
      if (path === "/api/me/memories/memory-fact-1" && init?.method === "PATCH") {
        return json({
          memory: memorySummaryFixture({
            currentVersionId: "memory-version-2",
            displayText: "I prefer concise technical answers."
          })
        });
      }
      if (path.endsWith("/forget")) {
        return json({
          memory: memorySummaryFixture({
            currentVersionId: null,
            displayText: null,
            factState: "FORGOTTEN",
            indexingState: "DEGRADED",
            sourceCount: 0,
            versionState: "FORGOTTEN"
          }),
          undo: {
            deletionId: "deletion-1",
            expiresAt: "2099-08-11T08:01:00.000Z",
            versionId: "memory-version-2"
          }
        });
      }
      if (path.endsWith("/undo-forget")) {
        return json({
          memory: memorySummaryFixture({
            currentVersionId: "memory-version-3",
            displayText: "I prefer concise technical answers."
          })
        });
      }
      return json({ error: "memory_action_failed" }, 500);
    }));

    render(
      <MemoryActionConfirmationV2
        action={{
          factId: "memory-fact-1",
          operation: "SAVE",
          statement: "I prefer concise answers in Russian.",
          status: "COMMITTED",
          versionId: "memory-version-1"
        }}
        locale="EN"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit" }), {
      target: { value: "I prefer concise technical answers." }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved text updated.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Saved memory removed.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByText("Memory restored.")).toBeVisible();
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /api/me/memory/mutation-authorizations",
      "PATCH /api/me/memories/memory-fact-1",
      "POST /api/me/memory/mutation-authorizations",
      "POST /api/me/memories/memory-fact-1/forget",
      "POST /api/me/memory/mutation-authorizations",
      "POST /api/me/memories/memory-fact-1/undo-forget"
    ]);
  });
});
