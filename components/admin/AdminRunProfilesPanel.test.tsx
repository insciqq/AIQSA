import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminRunProfilesPanel } from "./AdminRunProfilesPanel";

const models = [
  {
    connectionEnabled: true,
    defaultReasoningEffort: "medium",
    defaultReasoningMode: "standard",
    displayName: "GPT-5.6 Sol",
    id: "deployment-sol",
    modelEnabled: true,
    providerDisplayName: "Primary OpenAI",
    reasoningEfforts: ["none", "medium", "high", "max"],
    reasoningModes: ["standard", "pro"],
    selectable: true
  },
  {
    connectionEnabled: false,
    defaultReasoningEffort: "none",
    defaultReasoningMode: "standard",
    displayName: "Retired model",
    id: "deployment-retired",
    modelEnabled: true,
    providerDisplayName: "Old connection",
    reasoningEfforts: [],
    reasoningModes: ["standard"],
    selectable: false
  }
];

const profiles = [
  { description: "Fast questions", enabled: true, id: "fast", label: "Fast", providerModelId: "deployment-sol", reasoningEffort: "medium", reasoningMode: "standard", updatedAt: "2026-07-24T00:00:00.000Z", version: 2 },
  { description: "Everyday questions", enabled: true, id: "balanced", label: "Balanced", providerModelId: "deployment-sol", reasoningEffort: "medium", reasoningMode: "standard", updatedAt: "2026-07-24T00:00:00.000Z", version: 3 },
  { description: "Deep questions", enabled: true, id: "deep", label: "Deep", providerModelId: "deployment-sol", reasoningEffort: "max", reasoningMode: "pro", updatedAt: "2026-07-24T00:00:00.000Z", version: 4 }
];

function apiFetch() {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { profiles: Array<Record<string, unknown>> };
      return Response.json({
        models,
        profiles: body.profiles.map((profile) => ({
          ...profile,
          expectedVersion: undefined,
          label: profile.id === "fast" ? "Fast" : profile.id === "balanced" ? "Balanced" : "Deep",
          updatedAt: "2026-07-24T01:00:00.000Z",
          version: Number(profile.expectedVersion) + 1
        }))
      });
    }
    return Response.json({ models, profiles });
  });
}

describe("AdminRunProfilesPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the fixed profile matrix and saves all three slots atomically", async () => {
    const fetcher = apiFetch();
    vi.stubGlobal("fetch", fetcher);
    render(<AdminRunProfilesPanel active />);

    await waitFor(() => expect(screen.getByLabelText("Fast description")).toHaveValue("Fast questions"));
    expect(screen.getAllByRole("group").map((group) => group.textContent)).toEqual([
      expect.stringContaining("Fast"),
      expect.stringContaining("Balanced"),
      expect.stringContaining("Deep")
    ]);
    expect(screen.getAllByText("Enabled")).toHaveLength(3);
    expect(screen.getAllByRole("option", {
      name: "Old connection / Retired model (inactive)"
    })).toHaveLength(3);
    for (const option of screen.getAllByRole("option", {
      name: "Old connection / Retired model (inactive)"
    })) {
      expect(option).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Save profiles" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Fast description"), {
      target: { value: "Quick factual questions" }
    });
    const save = screen.getByRole("button", { name: "Save profiles" });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(
      "Run profiles saved for future messages."
    ));
    const put = fetcher.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put).toBeDefined();
    const body = JSON.parse(String(put?.[1]?.body)) as { profiles: Array<Record<string, unknown>> };
    expect(body.profiles).toHaveLength(3);
    expect(body.profiles[0]).toMatchObject({
      description: "Quick factual questions",
      expectedVersion: 2,
      id: "fast"
    });
  });

  it("uses the blank deployment option as an explicit disabled profile", async () => {
    const fetcher = apiFetch();
    vi.stubGlobal("fetch", fetcher);
    render(<AdminRunProfilesPanel active />);
    const modelSelect = await screen.findByLabelText("Fast model deployment");

    fireEvent.change(modelSelect, { target: { value: "" } });

    expect(screen.getAllByText("Enabled", { selector: "[data-resource-availability]" })).toHaveLength(3);
    expect(screen.getByText("Will be disabled after Save")).toHaveClass("text-caution");
    expect(screen.getByLabelText("Fast reasoning mode")).toBeDisabled();
    expect(screen.getByLabelText("Fast reasoning effort")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save profiles" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Disabled", { selector: "[data-resource-availability]" })).toHaveClass(
      "border-trace-strong",
      "text-ink"
    );
    expect(screen.queryByText("Will be disabled after Save")).not.toBeInTheDocument();
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as {
      profiles: Array<Record<string, unknown>>;
    };
    expect(body.profiles[0]).toMatchObject({
      enabled: false,
      id: "fast",
      providerModelId: null
    });
  });

  it("distinguishes an initial load failure from an empty profile catalog", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetcher);
    render(<AdminRunProfilesPanel active />);

    expect(await screen.findByText("Run profiles could not be loaded")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Run profiles could not be reached. Check the connection and retry."
    );
    expect(screen.queryByLabelText("Fast description")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss run profile error" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry run profiles" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
});
