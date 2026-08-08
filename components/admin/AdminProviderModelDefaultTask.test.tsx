import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminProviderModelDefaultTask } from "./AdminProviderModelDefaultTask";

const catalog = {
  candidates: [{
    connectionDisplayName: "Provider A",
    connectionId: "connection-a",
    displayName: "Model A",
    id: "model-a"
  }],
  policy: {
    defaultModel: null,
    updatedAt: "2026-08-08T00:00:00.000Z",
    updatedBy: null,
    version: 1
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("administrator provider model default task", () => {
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
      providerModelId: "model-a"
    });
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
