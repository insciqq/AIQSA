import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminProviderModelDefaultTask } from "./AdminProviderModelDefaultTask";

const catalog = {
  candidates: [{
    connectionDisplayName: "Provider A",
    connectionId: "connection-a",
    displayName: "Model A",
    defaultReasoningEffort: "medium",
    reasoningEfforts: ["low", "medium", "high"],
    id: "model-a"
  }],
  policy: {
    defaultModel: null,
    reasoningEffort: null,
    mcpAutoDiscoveryTimeoutSeconds: 60,
    maxMcpToolsPerDiscovery: 10,
    maxToolCalls: 20,
    maxToolRounds: 8,
    updatedAt: "2026-08-08T00:00:00.000Z",
    updatedBy: null,
    version: 1
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("administrator provider model default task", () => {
  it("saves a reasoning-only edit and reloads it with the same model", async () => {
    let current = {
      ...catalog,
      policy: { ...catalog.policy, defaultModel: { ...catalog.candidates[0]!, available: true }, reasoningEffort: null as string | null }
    };
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const update = JSON.parse(String(init.body));
        current = { ...current, policy: { ...current.policy, reasoningEffort: update.reasoningEffort, version: current.policy.version + 1 } };
      }
      return Response.json({ modelPolicy: current });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<AdminProviderModelDefaultTask active />);
    const reasoning = await screen.findByLabelText("Default reasoning effort");
    expect(screen.getByRole("button", { name: "Save default" })).toBeDisabled();
    fireEvent.change(reasoning, { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Save default" }));
    await screen.findByText("Reasoning: high.");
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({
      expectedVersion: 1, providerModelId: "model-a", reasoningEffort: "high"
    });
    unmount();
    render(<AdminProviderModelDefaultTask active />);
    expect(await screen.findByLabelText("Default reasoning effort")).toHaveValue("high");
    expect(screen.getByRole("button", { name: "Save default" })).toBeDisabled();
  });

  it("resets reasoning when the model changes and disables unsupported controls", async () => {
    const plain = { ...catalog.candidates[0]!, id: "plain", displayName: "Plain", reasoningEfforts: [], defaultReasoningEffort: null };
    const current = {
      ...catalog, candidates: [...catalog.candidates, plain],
      policy: { ...catalog.policy, defaultModel: { ...catalog.candidates[0]!, available: true }, reasoningEffort: "high" }
    };
    const fetchMock = vi.fn(async () => Response.json({ modelPolicy: current }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminProviderModelDefaultTask active />);
    fireEvent.change(await screen.findByLabelText("Active answer model deployment"), { target: { value: "plain" } });
    expect(screen.getByLabelText("Default reasoning effort")).toHaveValue("");
    expect(screen.getByLabelText("Default reasoning effort")).toBeDisabled();
    expect(screen.getByText("This model does not support adjustable reasoning.")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Active answer model deployment"), { target: { value: "model-a" } });
    expect(screen.getByLabelText("Default reasoning effort")).toHaveValue("");
    expect(screen.getByLabelText("Default reasoning effort")).toBeEnabled();
  });

  it("lets an obsolete reasoning selection be reset to Provider default", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ modelPolicy: {
      ...catalog,
      candidates: [{ ...catalog.candidates[0]!, reasoningEfforts: [], defaultReasoningEffort: null }],
      policy: { ...catalog.policy, defaultModel: { ...catalog.candidates[0]!, available: true }, reasoningEffort: "obsolete" }
    } })));
    render(<AdminProviderModelDefaultTask active />);
    const reasoning = await screen.findByLabelText("Default reasoning effort");
    expect(reasoning).toHaveValue("obsolete");
    expect(screen.getByRole("button", { name: "Save default" })).toBeDisabled();
    fireEvent.change(reasoning, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Save default" })).toBeEnabled();
  });

  it("loads candidates and saves one exact deployment with the observed version", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ modelPolicy: catalog }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        modelPolicy: {
          ...catalog,
          policy: {
            ...catalog.policy,
            defaultModel: { ...catalog.candidates[0], available: true },
            version: 2
          }
        }
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminProviderModelDefaultTask active />);
    const select = await screen.findByLabelText("Active answer model deployment");
    fireEvent.change(select, { target: { value: "model-a" } });
    fireEvent.click(screen.getByRole("button", { name: "Save default" }));

    await screen.findByText("Installation default updated.");
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      expectedVersion: 1,
      providerModelId: "model-a",
      reasoningEffort: null
    });
  });

  it("keeps duplicate connection/model candidates visibly distinct", async () => {
    const duplicateCatalog = {
      candidates: [
        catalog.candidates[0],
        {
          ...catalog.candidates[0],
          connectionDisplayName: " provider a ",
          connectionId: "connection-b",
          id: "model-b"
        }
      ],
      policy: {
        ...catalog.policy,
        defaultModel: { ...catalog.candidates[0], available: true }
      }
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ modelPolicy: duplicateCatalog }), { status: 200 })
    ));

    render(<AdminProviderModelDefaultTask active />);
    const select = await screen.findByLabelText("Active answer model deployment");
    const optionLabels = Array.from((select as HTMLSelectElement).options)
      .map(({ textContent }) => textContent ?? "")
      .filter((label) => label.includes("Model A"));

    expect(optionLabels).toHaveLength(2);
    expect(optionLabels[0]).toMatch(/^Provider A · ref [0-9A-Z]{6,} \/ Model A$/u);
    expect(optionLabels[1]).toMatch(/^ provider a  · ref [0-9A-Z]{6,} \/ Model A$/u);
    expect(optionLabels[0]).not.toBe(optionLabels[1]);
    expect(screen.getByText(/^Current: Provider A · ref [0-9A-Z]{6,} \/ Model A\.$/u))
      .toBeVisible();
  });

  it("keeps a stale edit visible and actionable", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ modelPolicy: catalog }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "model_policy_stale" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminProviderModelDefaultTask active />);
    fireEvent.change(await screen.findByLabelText("Active answer model deployment"), {
      target: { value: "model-a" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save default" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(
      "The installation default changed elsewhere"
    ));
  });
});
