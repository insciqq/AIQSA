import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  adminKnowledgeDestinationFixture,
  adminKnowledgeOperationsFixture,
  adminKnowledgeProfileFixture,
  adminKnowledgeVisionDestinationFixture
} from "@/tests/support/knowledgeProfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminKnowledgeSection } from "./AdminKnowledgeSection";

const settings = {
  ingestionLimits: {
    maxChunksPerDocument: 10_000,
    maxFileBytes: 25_000_000,
    maxNormalizedChars: 5_000_000,
    maxPages: 2_000
  },
  operations: adminKnowledgeOperationsFixture(),
  policy: {
    candidateLimit: 40,
    resultLimit: 8,
    scoreThreshold: 0.01,
    updatedAt: "2026-08-09T00:00:00.000Z",
    updatedBy: null,
    version: 1
  },
  profile: adminKnowledgeProfileFixture(),
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
    expect(screen.getByRole("heading", { name: "Operations health" })).toBeVisible();
    expect(screen.getByText("No active alerts")).toBeVisible();
    expect(screen.getByText(/V1 reconciliation · clean/)).toBeVisible();
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

  it("shows actionable aggregate alerts without exposing internal codes", async () => {
    const alertSettings = {
      ...settings,
      operations: adminKnowledgeOperationsFixture({
        alerts: [{
          code: "knowledge_v1_reconciliation_incomplete",
          severity: "critical"
        }],
        migration: {
          discrepancies: 2,
          mappedArtifacts: 1,
          mappedDocuments: 1,
          mappedVersions: 1,
          v1Artifacts: 2,
          v1Documents: 2,
          v1Versions: 2
        }
      })
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ knowledge: alertSettings }), { status: 200 })
    ));

    render(<AdminKnowledgeSection active />);

    expect(await screen.findByText("1 active alert")).toBeVisible();
    expect(screen.getByText("The legacy-to-Source reconciliation is incomplete.")).toBeVisible();
    expect(screen.queryByText("knowledge_v1_reconciliation_incomplete")).not.toBeInTheDocument();
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

  it("shows the content route and activates a tested destination for future work", async () => {
    const remote = {
      ...adminKnowledgeDestinationFixture,
      connectionDisplayName: "Approved provider",
      deploymentId: "embedding-model-2",
      modelDisplayName: "Multilingual production"
    };
    const initial = {
      ...settings,
      profile: adminKnowledgeProfileFixture({
        availableDestinations: [adminKnowledgeDestinationFixture, remote],
        availableVisionDestinations: [adminKnowledgeVisionDestinationFixture]
      })
    };
    const activated = {
      ...settings,
      profile: adminKnowledgeProfileFixture({
        activeRevision: {
          activatedAt: "2026-08-18T01:00:00.000Z",
          destination: remote,
          executionAuthority: "installation",
          id: "profile-revision-2",
          revisionNumber: 2,
          visionDestination: adminKnowledgeVisionDestinationFixture
        },
        availableDestinations: [adminKnowledgeDestinationFixture, remote],
        availableVisionDestinations: [adminKnowledgeVisionDestinationFixture],
        migration: {
          activeProfileBases: 0,
          buildingProfileBases: 1,
          legacyGenerations: 0,
          profiledGenerations: 1,
          totalBases: 1
        },
        version: 2
      })
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ knowledge: initial }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ knowledge: activated }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    render(<AdminKnowledgeSection active />);

    const route = await screen.findByTestId("knowledge-profile-route");
    expect(within(route).getByText("Documents")).toBeVisible();
    expect(within(route).getByText("Parser & OCR")).toBeVisible();
    expect(within(route).getByText("Local embeddings / Multilingual embed")).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: /Embedding destination/i }), {
      target: { value: remote.deploymentId }
    });
    fireEvent.change(screen.getByRole("combobox", { name: /Visual-analysis destination/i }), {
      target: { value: adminKnowledgeVisionDestinationFixture.deploymentId }
    });
    fireEvent.click(screen.getByRole("button", { name: "Activate for future processing" }));

    await screen.findByText(
      "Knowledge profile activated. Existing Bases are rebuilding safely in the background."
    );
    expect(screen.getByRole("status", { name: "Knowledge profile rollout" })).toHaveTextContent(
      "0 / 1 Bases ready"
    );
    expect(screen.getByText(/Current snapshots stay online/)).toBeVisible();
    const [, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      action: "activate_profile",
      deploymentId: remote.deploymentId,
      expectedVersion: 1,
      visionDeploymentId: adminKnowledgeVisionDestinationFixture.deploymentId
    });
  });
});
