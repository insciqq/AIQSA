import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { memorySummaryFixture } from "@/tests/support/memoryFixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryActionConfirmationV2 } from "./MemoryActionConfirmationV2";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

describe("committed Memory action confirmation", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("supports exact Save edit, Undo, and bounded Restore", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    let authorizationOrdinal = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      requests.push({ method: init?.method ?? "GET", path });
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
