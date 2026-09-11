import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminAttentionItem } from "@/lib/contracts/adminAttention";
import { ADMIN_OVERVIEW_EMPTY_COPY, AdminOverviewSection } from "./AdminOverviewSection";
import type { AdminAttentionController } from "./useAdminAttention";

const items: AdminAttentionItem[] = [
  {
    action: "Review users",
    code: "users_pending_approval",
    count: 3,
    detail: "pending@aiqsa.test and 2 more",
    id: "users_pending_approval",
    severity: "warn",
    target: { filter: "pending", section: "users" },
    title: "Users are waiting for approval"
  },
  {
    action: "Open Search",
    code: "search_source_model_off",
    count: 1,
    detail: "Its model Sonar on OpenRouter is not available — turn the model on, or archive the source",
    id: "search_source_model_off:perplexity",
    severity: "bad",
    target: { resource: "perplexity", section: "search" },
    title: "Perplexity Search has no working source"
  },
  {
    action: "Set up email",
    code: "email_not_configured",
    count: null,
    detail: "Invites and approvals are sent by link only until SMTP is set up",
    id: "email_not_configured",
    severity: "neutral",
    target: { section: "email" },
    title: "Email delivery is not configured"
  }
];

function controller(overrides: Partial<AdminAttentionController> = {}): AdminAttentionController {
  return {
    attention: { checkedAt: "2026-09-07T12:00:00.000Z", items, unavailable: [] },
    loading: false,
    refresh: vi.fn(async () => undefined),
    unavailable: false,
    staleItems: {},
    ...overrides
  };
}

describe("AdminOverviewSection", () => {
  it("never calls failed or incomplete checks healthy and marks retained observations", () => {
    const view = render(<AdminOverviewSection controller={controller({ unavailable: true,
      staleItems: { [items[0]!.id]: "2026-09-07T12:00:00.000Z" }
    })} onJump={vi.fn()} />);
    expect(screen.getByText(/Check unavailable · last confirmed/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("current health is unknown");
    expect(screen.queryByText(/No issues found|everything is working/)).not.toBeInTheDocument();
    view.rerender(<AdminOverviewSection controller={controller({ attention: {
      checkedAt: "2026-09-07T12:00:25.000Z", items: [], unavailable: ["memory"]
    } })} onJump={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Could not check Memory");
    expect(screen.queryByText(/No issues found|everything is working/)).not.toBeInTheDocument();
  });
  it("lists every item with its severity, count, copy and one jump action", () => {
    const onJump = vi.fn();
    render(<AdminOverviewSection controller={controller()} onJump={onJump} />);

    const list = screen.getByRole("list", { name: "Needs attention" });
    const rows = within(list).getAllByTestId("admin-attention-item");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("3");
    expect(rows[0]).toHaveTextContent("Users are waiting for approval");
    expect(rows[0]).toHaveTextContent("pending@aiqsa.test and 2 more");
    expect(rows[0]?.querySelector("[data-severity]")).toHaveAttribute("data-severity", "warn");
    expect(rows[1]?.querySelector("[data-severity]")).toHaveAttribute("data-severity", "bad");
    expect(rows[2]).toHaveTextContent("—");
    expect(screen.getByText(ADMIN_OVERVIEW_EMPTY_COPY)).toBeInTheDocument();

    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Open Search: Perplexity Search has no working source" }));
    expect(onJump).toHaveBeenCalledWith({ resource: "perplexity", section: "search" });
    fireEvent.click(within(rows[2]!).getByRole("button", { name: /Set up email/ }));
    expect(onJump).toHaveBeenCalledWith({ section: "email" });
  });

  it("limits the healthy empty claim to the latest complete check", () => {
    render(
      <AdminOverviewSection
        controller={controller({ attention: { checkedAt: "2026-09-07T12:00:00.000Z", items: [], unavailable: [] } })}
        onJump={vi.fn()}
      />
    );
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByText(ADMIN_OVERVIEW_EMPTY_COPY)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("No issues found in the latest checks.");
  });

  it("keeps loading, failure and partially unavailable states distinct", () => {
    const refresh = vi.fn(async () => undefined);
    const view = render(
      <AdminOverviewSection controller={controller({ attention: null, loading: true, refresh })} onJump={vi.fn()} />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Checking what needs attention…");

    view.rerender(
      <AdminOverviewSection
        controller={controller({ attention: null, loading: false, refresh, unavailable: true })}
        onJump={vi.fn()}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The attention list could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledTimes(1);

    view.rerender(
      <AdminOverviewSection
        controller={controller({
          attention: { checkedAt: "2026-09-07T12:00:00.000Z", items: [items[0]!], unavailable: ["memory", "mcp"] }
        })}
        onJump={vi.fn()}
      />
    );
    expect(screen.getByRole("list", { name: "Needs attention" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Could not check Memory, MCP servers right now — those items may be missing.");
  });
});
