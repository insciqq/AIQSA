import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  adminKnowledgeDestinationFixture,
  adminKnowledgeOperationsFixture,
  adminKnowledgeProfileFixture
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
  profile: adminKnowledgeProfileFixture(),
  retrieval: {
    candidateLimit: 40 as const,
    resultLimit: 8 as const
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("administrator Knowledge section", () => {
  it("shows fixed privacy-neutral retrieval and ingestion facts without mutable controls", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ knowledge: settings }), { status: 200 })
    ));

    render(<AdminKnowledgeSection active />);

    expect(await screen.findByText("25 MB")).toBeVisible();
    expect(screen.getByText(/never lists private bases/i)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Fixed retrieval" })).toBeVisible();
    const fixedRetrieval = screen.getByRole("heading", { name: "Fixed retrieval" })
      .parentElement!;
    expect(within(fixedRetrieval).getByText("40")).toBeVisible();
    expect(within(fixedRetrieval).getByText("8")).toBeVisible();
    expect(screen.queryByRole("button", { name: /save retrieval policy/i }))
      .not.toBeInTheDocument();
    expect(screen.queryByLabelText(/candidate passages/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/visual-analysis destination/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Operations health" })).toBeVisible();
    expect(screen.getByText("No active alerts")).toBeVisible();
    expect(screen.getByText(/V1 reconciliation · clean/)).toBeVisible();
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

  it("shows the content route and activates only a tested embedding destination", async () => {
    const onMutationCommitted = vi.fn();
    const remote = {
      ...adminKnowledgeDestinationFixture,
      connectionDisplayName: "Approved provider",
      deploymentId: "embedding-model-2",
      modelDisplayName: "Multilingual production"
    };
    const initial = {
      ...settings,
      profile: adminKnowledgeProfileFixture({
        availableDestinations: [adminKnowledgeDestinationFixture, remote]
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
          revisionNumber: 2
        },
        availableDestinations: [adminKnowledgeDestinationFixture, remote],
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

    render(<AdminKnowledgeSection active onMutationCommitted={onMutationCommitted} />);

    const route = await screen.findByTestId("knowledge-profile-route");
    expect(within(route).getByText("Documents")).toBeVisible();
    expect(within(route).getByText("Parser & OCR")).toBeVisible();
    expect(within(route).getByText("Local embeddings / Multilingual embed")).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: /Embedding destination/i }), {
      target: { value: remote.deploymentId }
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
      expectedVersion: 1
    });
    expect(onMutationCommitted).toHaveBeenCalledOnce();
  });
});
