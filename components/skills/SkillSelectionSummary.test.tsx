import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSkillLibraryStoreForTest, useSkillLibraryStore } from "@/components/app-shell/skillLibraryStore";
import { SkillSelectionSummary } from "./SkillSelectionSummary";

afterEach(() => { cleanup(); resetSkillLibraryStoreForTest(); });

describe("Skill instruction estimates", () => {
  it("excludes on-demand dependencies from pinned counts and instruction budgets", () => {
    render(<SkillSelectionSummary includedSkills={[{ id: "pinned", name: "Always", mode: "pinned", instructionApproxTokens: 25 },
      { id: "optional", name: "On demand", mode: "available", instructionApproxTokens: 900 }]}
      manualSkills={[]} availableCount={1} modelContextWindow={1000} onRemove={vi.fn()} />);
    expect(screen.getByText("1 always included · ≈25 instruction tokens · 2.5% of model window")).toBeVisible();
    expect(screen.getByText("1 skills available on demand")).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("counts overlap once, uses server estimates, and warns above 25% without blocking removal", () => {
    render(<SkillSelectionSummary includedSkills={[{ id: "assistant", name: "Assistant workflow" }]}
      manualSkills={[{ id: "assistant", name: "Assistant workflow" }, { id: "manual", name: "Review", instructionApproxTokens: 50 }]}
      estimates={[{ id: "assistant", instructionApproxTokens: 201 }]} modelContextWindow={1000} onRemove={vi.fn()} />);
    expect(screen.getByText("2 always included · ≈251 instruction tokens · 25.1% of model window")).toBeVisible();
    expect(screen.getByText("Assistant: ≈201 · Yours: ≈50")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("more than 25%");
    expect(screen.getByRole("button", { name: "Remove manual Review" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not borrow an estimate from an unrelated personal catalog", () => {
    useSkillLibraryStore.setState({ data: { nextCursor: null, publishableWorkspaces: [], viewer: { canPublishInstallation: false }, skills: [{
      id: "project-skill", name: "Personal revision", description: "", archived: false, instructionCharacterCount: 20,
      instructionApproxTokens: 999, owned: true, ownerDisplayName: "Viewer", scope: { kind: "owner" }, version: 1, updatedAt: "2026-09-21"
    }] } });
    render(<SkillSelectionSummary includedSkills={[]} manualSkills={[{ id: "project-skill", name: "Project revision" }]} modelContextWindow={1000} onRemove={vi.fn()} />);
    expect(screen.getByText(/Some estimates are unavailable/)).toBeVisible();
    expect(screen.getByText("1 always included · Instruction estimate unavailable")).toBeVisible();
    expect(screen.getByText(/Yours: unavailable/)).toBeVisible();
    expect(screen.queryByText(/999/)).toBeNull();
    expect(screen.queryByText(/model window/)).toBeNull();
  });

  it("deduplicates estimates and labels incomplete totals and percentages as lower bounds", () => {
    const assistant = { id: "assistant", name: "Assistant", instructionApproxTokens: 201 };
    const manual = { id: "manual", name: "Manual", instructionApproxTokens: 50 };
    render(<SkillSelectionSummary includedSkills={[assistant, assistant]}
      manualSkills={[assistant, manual, manual, { id: "unknown", name: "Unavailable estimate" }]}
      estimates={[{ id: "assistant", instructionApproxTokens: 900 }]}
      modelContextWindow={1000} onRemove={vi.fn()} />);
    expect(screen.getByText("3 always included · At least ≈251 instruction tokens · at least 25.1% of model window")).toBeVisible();
    expect(screen.getByText(/Assistant: ≈201 · Yours: At least ≈50/)).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("more than 25%");
    expect(screen.getAllByRole("button", { name: "Remove manual Manual" })).toHaveLength(1);
  });
});
