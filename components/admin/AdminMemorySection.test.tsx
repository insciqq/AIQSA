import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminMemorySection } from "./AdminMemorySection";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    memoryEgress: {
      acceptedAt: null,
      acceptedBy: null,
      acceptedFingerprint: null,
      acceptedPolicyVersion: null,
      consentMode: "ADMIN",
      currentFingerprint: "a".repeat(64),
      currentPolicyVersion: "memory-utility-egress-v1",
      destinations: [
        { destinations: ["Selected and bound for each accepted run"], id: "answer_provider", reviewRequired: false, state: "BOUND_PER_RUN" },
        { destinations: ["System connection / System model"], id: "system_model", reviewRequired: true, state: "AVAILABLE" },
        { destinations: ["Embedding connection / Embedding model"], id: "embedding", reviewRequired: true, state: "AVAILABLE" },
        { destinations: [], id: "remote_reranker", reviewRequired: false, state: "UNAVAILABLE" }
      ],
      reviewRequired: true,
      version: 1,
      waitingJobCount: 2,
      ...overrides
    }
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AdminMemorySection", () => {
  it("shows the four-row review and acknowledges the exact current fingerprint", async () => {
    let server = payload();
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        bodies.push(JSON.parse(String(init.body)));
        server = payload({
          acceptedAt: "2026-08-11T10:00:00.000Z",
          acceptedBy: { displayName: "Administrator", id: "admin-1" },
          acceptedFingerprint: "a".repeat(64),
          acceptedPolicyVersion: "memory-utility-egress-v1",
          destinations: payload().memoryEgress.destinations.map((row) => ({
            ...row,
            reviewRequired: false
          })),
          reviewRequired: false,
          version: 2
        });
      }
      return Response.json(server);
    }));

    render(<AdminMemorySection active />);

    expect(await screen.findByRole("heading", { name: "Memory destinations" })).toBeVisible();
    const matrix = screen.getByRole("list", { name: "Memory destination matrix" });
    expect(within(matrix).getAllByRole("listitem", { hidden: false }).length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("Review required.")).toBeVisible();
    expect(screen.getByText("System connection / System model")).toBeVisible();
    expect(screen.getByText("2", { selector: "dd" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Acknowledge current destinations" }));
    await waitFor(() => expect(screen.getByText(
      "Current Memory destinations acknowledged. Waiting work will resume automatically."
    )).toBeVisible());
    expect(bodies).toEqual([{
      currentFingerprint: "a".repeat(64),
      expectedVersion: 1
    }]);
    expect(screen.queryByRole("button", { name: "Acknowledge current destinations" }))
      .not.toBeInTheDocument();
  });

  it("keeps PER_USER review on the user surface", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload({
      consentMode: "PER_USER",
      reviewRequired: false
    }))));
    render(<AdminMemorySection active />);

    expect(await screen.findByText(/uses per-user destination review/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Acknowledge current destinations" }))
      .not.toBeInTheDocument();
  });
});
