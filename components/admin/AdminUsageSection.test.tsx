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
  it("renders the complete read-only usage ledger and native comparison tables", () => {
    render(<AdminUsageSection catalog={catalog} usage={populatedUsage()} />);

    const summary = screen.getByRole("region", { name: "Usage summary" });
    expect(within(summary).getByText("Provider-reported · all recorded usage")).toBeVisible();
    expect(summary).toHaveClass("min-w-0", "border-y", "border-trace-subtle");
    expect(within(summary).getByTestId("usage-total-tokens")).toHaveTextContent(
      new Intl.NumberFormat(undefined).format(1000)
    );
    expect(summary).toHaveTextContent("2 retained runs with reported usage across 1 user and 1 group");
    expect(summary).toHaveTextContent("Input tokens600");
    expect(summary).toHaveTextContent("Cached input120");
    expect(summary).toHaveTextContent("Cache write30");
    expect(summary).toHaveTextContent("Output tokens400");
    expect(summary).toHaveTextContent("Reasoning tokens100");
    expect(screen.getByText("How to read these numbers")).toBeVisible();

    const groupRegion = screen.getByRole("region", { name: "Group usage table" });
    const userRegion = screen.getByRole("region", { name: "User usage table" });
    expect(groupRegion).toHaveAttribute("tabindex", "0");
    expect(userRegion).toHaveAttribute("tabindex", "0");
    expect(screen.getByTestId("admin-usage-groups")).toHaveClass("min-w-0");
    expect(screen.getByTestId("admin-usage-users")).toHaveClass("min-w-0");
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
    expect(within(userRegion).getByText("OpenAI / GPT 5.5")).toBeVisible();
    expect(within(userRegion).getByText("No reported usage")).toBeVisible();
    const mobileGroups = screen.getByTestId("admin-usage-groups-mobile");
    const mobileUsers = screen.getByTestId("admin-usage-users-mobile");
    expect(mobileGroups).toHaveClass("lg:hidden");
    expect(mobileUsers).toHaveClass("lg:hidden");
    expect(within(mobileGroups).getByText("Operators")).toBeVisible();
    expect(within(mobileUsers).getByText(/OpenAI \/ GPT 5\.5/)).toBeVisible();
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

    expect(within(screen.getByRole("region", { name: "Usage summary" })).getByText("Never")).toBeVisible();
    const groupTable = screen.getByRole("region", { name: "Group usage table" });
    const userTable = screen.getByRole("region", { name: "User usage table" });
    expect(within(groupTable).getByText("No groups in this installation").closest("td")).toHaveAttribute("colspan", "5");
    expect(within(userTable).getByText("No users in this installation").closest("td")).toHaveAttribute("colspan", "7");
    expect(within(screen.getByTestId("admin-usage-groups-mobile")).getByText("No groups in this installation")).toBeVisible();
    expect(within(screen.getByTestId("admin-usage-users-mobile")).getByText("No users in this installation")).toBeVisible();
  });

  it("counts detached provider-reported usage even when no retained run remains", () => {
    const usage = populatedUsage();
    usage.byUser[1] = {
      ...usage.byUser[1],
      inputTokens: 5,
      lastUsedAt: "2026-07-01T00:00:00.000Z",
      totalTokens: 5
    };
    usage.byGroup[1] = {
      ...usage.byGroup[1],
      contributingUsers: 1,
      inputTokens: 5,
      lastUsedAt: "2026-07-01T00:00:00.000Z",
      totalTokens: 5
    };

    render(<AdminUsageSection catalog={catalog} usage={usage} />);

    expect(screen.getByRole("region", { name: "Usage summary" })).toHaveTextContent(
      "2 retained runs with reported usage across 2 users and 2 groups"
    );
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

    expect(screen.getAllByText("Archived group")).toHaveLength(2);
    expect(screen.getAllByText("No email")).toHaveLength(2);
    expect(screen.getAllByText("No groups")).toHaveLength(2);
    expect(screen.getAllByText(/Unavailable model/)).toHaveLength(2);
    expect(screen.queryByText(/unknown-provider|unknown-model/)).not.toBeInTheDocument();
  });
});
