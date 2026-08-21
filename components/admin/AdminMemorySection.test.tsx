import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminMemorySection } from "./AdminMemorySection";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    memory: {
      admissionTimeout: { seconds: 15, version: 4 },
      activeIssueCode: null,
      configuredTargets: [
        { model: "Utility model", provider: "Primary provider" },
        { model: "Embedding model", provider: "Vector provider" }
      ],
      index: { generation: 4, readiness: "READY" },
      queue: { length: 0, oldestAgeSeconds: null },
      rebuild: { state: "NOT_REQUIRED" },
      worker: { state: "RUNNING" },
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
  it("shows only the minimal operational readout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload({
      activeIssueCode: "memory_provider_failed",
      queue: { length: 3, oldestAgeSeconds: 125 }
    }))));
    render(<AdminMemorySection active />);

    expect(await screen.findByRole("heading", { name: "Memory status" })).toBeVisible();
    const configured = screen.getByRole("list", { name: "Configured models and providers" });
    expect(within(configured).getByText(/Utility model/u)).toBeVisible();
    expect(screen.getByText("Running")).toBeVisible();
    expect(screen.getByText("3 waiting · oldest 2m")).toBeVisible();
    expect(screen.getByText("Generation 4 · Ready")).toBeVisible();
    expect(screen.getByText("memory_provider_failed")).toBeVisible();
    expect(screen.getByRole("spinbutton", {
      name: "Memory admission timeout (seconds)"
    })).toHaveValue(15);
    expect(screen.queryByText(/fingerprint|policy revision|destination matrix/iu))
      .not.toBeInTheDocument();
  });

  it("admits the bounded rebuild and renders fresh progress", async () => {
    const calls: Array<{ body?: string; method?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: init?.body ? String(init.body) : undefined, method: init?.method });
      if (init?.method === "POST") {
        return Response.json(payload({
          index: { generation: 5, readiness: "REBUILDING" },
          queue: { length: 1, oldestAgeSeconds: 0 },
          rebuild: { state: "IN_PROGRESS" }
        }), { status: 202 });
      }
      return Response.json(payload({
        index: { generation: 4, readiness: "REBUILD_REQUIRED" },
        rebuild: { state: "AVAILABLE" }
      }));
    }));
    render(<AdminMemorySection active />);

    fireEvent.click(await screen.findByRole("button", { name: "Rebuild index" }));
    await waitFor(() => expect(screen.getByText("A bounded Memory index rebuild was queued."))
      .toBeVisible());
    expect(screen.getByText("A generation-safe rebuild is in progress.")).toBeVisible();
    expect(calls).toContainEqual({
      body: JSON.stringify({ action: "REBUILD_REQUIRED" }),
      method: "POST"
    });
  });

  it("keeps stopped-worker rebuild unavailable and clear", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload({
      index: { generation: "MIXED", readiness: "REBUILD_REQUIRED" },
      rebuild: { state: "UNAVAILABLE" },
      worker: { state: "NOT_RUNNING" }
    }))));
    render(<AdminMemorySection active />);

    expect(await screen.findByText("Not running")).toBeVisible();
    expect(screen.getByText(/cannot start until the Memory worker/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Rebuild index" }))
      .not.toBeInTheDocument();
  });

  it("saves a new timeout for future Memory admissions", async () => {
    const calls: Array<{ body?: string; method?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: init?.body ? String(init.body) : undefined, method: init?.method });
      return Response.json(payload(init?.method === "PUT"
        ? { admissionTimeout: { seconds: 30, version: 5 } }
        : {}));
    }));
    render(<AdminMemorySection active />);

    const timeout = await screen.findByRole("spinbutton", {
      name: "Memory admission timeout (seconds)"
    });
    fireEvent.change(timeout, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save timeout" }));

    await waitFor(() => expect(screen.getByText(/timeout saved/iu)).toBeVisible());
    expect(timeout).toHaveValue(30);
    expect(calls).toContainEqual({
      body: JSON.stringify({ expectedVersion: 4, timeoutSeconds: 30 }),
      method: "PUT"
    });
  });
});
