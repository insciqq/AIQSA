import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AdminCatalog, AdminUsageDashboard } from "@/lib/contracts/admin";
import { AdminUsageSection } from "./AdminUsageSection";

const catalog: AdminCatalog = {
  models: [{
    displayName: "GPT 5.5",
    modelId: "opaque-model-id",
    provider: "opaque-connection-id",
    providerFamily: "openai",
    upstreamModelId: "gpt-5.5"
  }],
  providers: [{ id: "opaque-connection-id", name: "OpenAI" }],
  searchStrategies: []
};

function emptyTotals() {
  return {
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    inputTokens: 0,
    lastUsedAt: null,
    outputTokens: 0,
    reasoningTokens: 0,
    runCount: 0,
    totalTokens: 0
  };
}

function populatedUsage(): AdminUsageDashboard {
  return {
    byGroup: [
      {
        ...emptyTotals(),
        contributingUsers: 1,
        groupId: "group-active",
        inputTokens: 600,
        lastUsedAt: "2026-07-12T08:00:00.000Z",
        name: "Operators",
        outputTokens: 400,
        runCount: 2,
        totalTokens: 1000,
        userCount: 2,
        archivedAt: null
      },
      {
        ...emptyTotals(),
        archivedAt: "2026-07-01T00:00:00.000Z",
        contributingUsers: 0,
        groupId: "group-archived",
        name: "Former team",
        userCount: 0
      }
    ],
    byUser: [
      {
        ...emptyTotals(),
        displayName: "Alice Operator",
        email: "alice@example.com",
        groups: [{ groupId: "group-active", name: "Operators", role: "member" }],
        inputTokens: 600,
        lastUsedAt: "2026-07-12T08:00:00.000Z",
        outputTokens: 400,
        providerModels: [
          {
            ...emptyTotals(),
            inputTokens: 600,
            lastUsedAt: "2026-07-12T08:00:00.000Z",
            modelId: "gpt-5.5",
            outputTokens: 400,
            provider: "openai",
            runCount: 2,
            totalTokens: 1000
          }
        ],
        runCount: 2,
        totalTokens: 1000,
        userId: "user-alice"
      },
      {
        ...emptyTotals(),
        displayName: "No Usage User",
        email: null,
        groups: [],
        providerModels: [],
        userId: "user-empty"
      }
    ],
    totals: {
      ...emptyTotals(),
      cachedInputTokens: 120,
      cacheWriteInputTokens: 30,
      inputTokens: 600,
      lastUsedAt: "2026-07-12T08:00:00.000Z",
      outputTokens: 400,
      reasoningTokens: 100,
      runCount: 2,
      totalTokens: 1000
    }
  };
}

describe("AdminUsageSection", () => {
  it("renders the complete read-only summary and native usage tables", () => {
    render(<AdminUsageSection catalog={catalog} usage={populatedUsage()} />);

    expect(screen.getByRole("region", { name: "Usage summary" })).toHaveTextContent("1 users / 1 groups");
    expect(screen.getByText(new Intl.NumberFormat(undefined).format(1000), { selector: ".text-lg" })).toBeVisible();

    const groupRegion = screen.getByRole("region", { name: "Group usage table" });
    const userRegion = screen.getByRole("region", { name: "User usage table" });
    expect(groupRegion).toHaveAttribute("tabindex", "0");
    expect(userRegion).toHaveAttribute("tabindex", "0");
    expect(within(groupRegion).getByRole("table")).toBeVisible();
    expect(within(userRegion).getByRole("table")).toBeVisible();
    expect(within(groupRegion).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Group",
      "Users",
      "Runs",
      "Tokens",
      "Last usage"
    ]);
    expect(within(userRegion).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "User",
      "Groups",
      "Runs",
      "Tokens",
      "Input / output",
      "Top model",
      "Last usage"
    ]);
    expect(screen.getByText("OpenAI / GPT 5.5")).toBeVisible();
    expect(screen.getByText("No reported usage")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.queryByText(/cost/i)).not.toBeInTheDocument();
  });

  it("keeps both table regions and deliberate empty rows mounted", () => {
    const usage: AdminUsageDashboard = {
      byGroup: [],
      byUser: [],
      totals: emptyTotals()
    };
    render(<AdminUsageSection catalog={catalog} usage={usage} />);

    expect(screen.getByText("Never", { selector: ".text-lg" })).toBeVisible();
    expect(screen.getByText("No groups").closest("td")).toHaveAttribute("colspan", "5");
    expect(screen.getByText("No users").closest("td")).toHaveAttribute("colspan", "7");
    expect(screen.getByRole("region", { name: "Group usage table" })).toBeVisible();
    expect(screen.getByRole("region", { name: "User usage table" })).toBeVisible();
  });

  it("preserves archived, missing-identity, and no-group context without raw catalog fallbacks", () => {
    const usage = populatedUsage();
    usage.byUser[1] = {
      ...usage.byUser[1],
      providerModels: [
        {
          ...emptyTotals(),
          modelId: "unknown-model",
          provider: "unknown-provider",
          runCount: 1,
          totalTokens: 5
        }
      ],
      runCount: 1,
      totalTokens: 5
    };
    render(<AdminUsageSection catalog={catalog} usage={usage} />);

    expect(screen.getByText("Archived group")).toBeVisible();
    expect(screen.getByText("No email")).toBeVisible();
    expect(screen.getByText("No groups")).toBeVisible();
    expect(screen.getByText("Unavailable model")).toBeVisible();
    expect(screen.queryByText(/unknown-provider|unknown-model/)).not.toBeInTheDocument();
  });
});
