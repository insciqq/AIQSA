import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminKnowledgeSection } from "./AdminKnowledgeSection";

const settings = {
  ingestionLimits: {
    maxChunksPerDocument: 10_000,
    maxFileBytes: 25_000_000,
    maxNormalizedChars: 5_000_000,
    maxPages: 2_000
  },
  policy: {
    candidateLimit: 40,
    resultLimit: 8,
    scoreThreshold: 0.01,
    updatedAt: "2026-08-09T00:00:00.000Z",
    updatedBy: null,
    version: 1
  },
  retrievalBounds: {
    candidateLimit: { max: 100, min: 1 },
    resultLimit: { max: 8, min: 1 },
    scoreThreshold: { max: 1, min: 0 }
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("administrator Knowledge section", () => {
  it("shows privacy-neutral limits and saves the observed policy version", async () => {
    const onMutationCommitted = vi.fn();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ knowledge: settings }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        knowledge: {
          ...settings,
          policy: {
            ...settings.policy,
            candidateLimit: 24,
            resultLimit: 6,
            scoreThreshold: 0.12,
            version: 2
          }
        }
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    render(<AdminKnowledgeSection active onMutationCommitted={onMutationCommitted} />);
    expect(await screen.findByText("25 MB")).toBeVisible();
    expect(screen.getByText(/never lists private bases/i)).toBeVisible();
    fireEvent.change(screen.getByLabelText(/Candidate passages/), { target: { value: "24" } });
    fireEvent.change(screen.getByLabelText(/Returned passages/), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText(/Score threshold/), { target: { value: "0.12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save retrieval policy" }));

    await screen.findByText("Knowledge retrieval policy updated.");
    const [, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      candidateLimit: 24,
      expectedVersion: 1,
      resultLimit: 6,
      scoreThreshold: 0.12
    });
    expect(onMutationCommitted).toHaveBeenCalledOnce();
  });

  it("keeps invalid relationships local and preserves a stale draft", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ knowledge: settings }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "knowledge_policy_stale" }), { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    render(<AdminKnowledgeSection active />);

    const candidates = await screen.findByLabelText(/Candidate passages/);
    fireEvent.change(candidates, { target: { value: "2" } });
    expect(screen.getByRole("button", { name: "Save retrieval policy" })).toBeDisabled();
    expect(screen.getByText(/returned passages cannot exceed candidates/i)).toBeVisible();
    fireEvent.change(candidates, { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save retrieval policy" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(
      "Knowledge settings changed elsewhere"
    ));
    expect(candidates).toHaveValue(20);
  });
});
