import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AdminHealthQueueRow } from "@/lib/contracts/adminHealthQueues";
import { AdminHealthSection } from "./AdminHealthSection";
import { queueAgeLabel, AdminHealthQueues } from "./AdminHealthQueues";
import { requestAdminHealthQueues, type AdminHealthQueuesController, type AdminHealthQueuesResult } from "./useAdminHealthQueues";

function row(overrides: Partial<AdminHealthQueueRow>): AdminHealthQueueRow {
  return {
    queue: "attachment_processing", state: "ok", waiting: 0, running: 0, oldestSeconds: null, failed24h: 0,
    slowAfterSeconds: 600, stalledAfterSeconds: 1_800, ...overrides
  };
}

const rows: AdminHealthQueueRow[] = [
  row({ queue: "attachment_processing", state: "stalled", waiting: 12, running: 1, oldestSeconds: 3 * 3_600 + 5 * 60, failed24h: 2 }),
  row({ queue: "chat_titles", state: "slow", waiting: 3, oldestSeconds: 11 * 60 }),
  row({ queue: "memory", state: "ok", waiting: 0, oldestSeconds: null, failed24h: null, slowAfterSeconds: 900, stalledAfterSeconds: 3_600 }),
  row({ queue: "file_deletion", state: "unavailable", waiting: null, running: null, failed24h: null })
];

const snapshot = { checkedAt: "2026-10-07T12:00:00.000Z", queues: rows };

function controller(overrides: Partial<AdminHealthQueuesController> = {}): AdminHealthQueuesController {
  return { queues: snapshot, loading: false, refreshing: false, error: null, refresh: vi.fn(), ...overrides };
}

describe("AdminHealthQueues", () => {
  it("shows every queue with its plain-English name, state, counts and oldest age", () => {
    render(<AdminHealthQueues controller={controller()} />);
    const cards = screen.getAllByTestId("admin-health-queue-card");
    expect(cards.map((card) => card.getAttribute("data-queue"))).toEqual(["attachment_processing", "chat_titles", "memory", "file_deletion"]);

    const stalled = within(cards[0]!);
    expect(stalled.getByText("Chat file processing")).toBeVisible();
    expect(stalled.getByTestId("admin-health-queue-state")).toHaveAttribute("data-state", "stalled");
    expect(stalled.getByText("Stalled")).toBeVisible();
    expect(stalled.getByText("Oldest over 30 min")).toBeVisible();
    expect(stalled.getByText("12")).toBeVisible();
    expect(stalled.getByText("3 h 5 min")).toBeVisible();

    expect(within(cards[1]!).getByText("Oldest over 10 min")).toBeVisible();
    expect(within(cards[2]!).getByTitle("This queue does not record failures")).toHaveTextContent("—");
    const unavailable = within(cards[3]!);
    expect(unavailable.getByText("Unavailable")).toBeVisible();
    expect(unavailable.getByText("Could not be read just now")).toBeVisible();

    // The wide table carries the same rows.
    expect(screen.getAllByTestId("admin-health-queue-row")).toHaveLength(4);
    expect(screen.getByRole("columnheader", { name: "Failed (24 h)" })).toBeInTheDocument();
  });

  it("keeps the last snapshot after a failed refresh and offers a retry when nothing loaded", () => {
    const { rerender } = render(<AdminHealthQueues controller={controller({ error: "unavailable" })} />);
    expect(screen.getByText(/Refresh failed\. Showing queues from/u)).toBeVisible();
    expect(screen.getAllByTestId("admin-health-queue-card")).toHaveLength(4);

    const refresh = vi.fn();
    rerender(<AdminHealthQueues controller={controller({ queues: null, error: "unavailable", refresh })} />);
    fireEvent.click(within(screen.getByTestId("admin-health-queues-unavailable")).getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledTimes(1);

    rerender(<AdminHealthQueues controller={controller({ queues: null, loading: true })} />);
    expect(screen.getByTestId("admin-health-queues-loading")).toBeVisible();
  });

  it("formats ages from seconds to days", () => {
    expect([null, 30, 59 * 60, 2 * 3_600, 3 * 86_400].map(queueAgeLabel)).toEqual(["—", "<1 min", "59 min", "2 h", "3 days"]);
  });
});

describe("Health section background queues", () => {
  it("loads the queues card and refreshes it with the rest of the page", async () => {
    const requestQueues = vi.fn(async (): Promise<AdminHealthQueuesResult> => ({ ok: true, queues: snapshot }));
    render(
      <AdminHealthSection
        filter={null}
        onSelectFilter={vi.fn()}
        requestHealth={async () => ({ ok: false, error: "unavailable" })}
        requestIncidents={async () => ({ ok: true, page: { incidents: [], nextCursor: null } })}
        requestQueues={requestQueues}
      />
    );
    // A failed telemetry read leaves the queue card working.
    expect(await screen.findByTestId("admin-health-unavailable")).toBeVisible();
    expect(await screen.findByTestId("admin-health-queues")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Background queues" })).toBeVisible();
    expect(requestQueues).toHaveBeenCalledTimes(1);
  });

  it("decodes the route response and maps refusals and malformed bodies", async () => {
    const respond = (status: number, body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
    await expect(requestAdminHealthQueues(undefined, respond(200, { queues: snapshot }))).resolves.toEqual({ ok: true, queues: snapshot });
    await expect(requestAdminHealthQueues(undefined, respond(403, { error: "forbidden" }))).resolves.toEqual({ ok: false, error: "forbidden" });
    await expect(requestAdminHealthQueues(undefined, respond(200, { queues: { checkedAt: "x", queues: [] } })))
      .resolves.toEqual({ ok: false, error: "unavailable" });
    await expect(requestAdminHealthQueues(undefined, vi.fn().mockRejectedValue(new TypeError("offline"))))
      .resolves.toEqual({ ok: false, error: "unavailable" });
  });
});
