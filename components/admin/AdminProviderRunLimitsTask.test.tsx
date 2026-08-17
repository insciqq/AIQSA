import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminProviderRunLimitsTask } from "./AdminProviderRunLimitsTask";

const catalog = {
  candidates: [],
  policy: {
    defaultModel: null,
    mcpAutoDiscoveryTimeoutSeconds: 60,
    maxMcpToolsPerDiscovery: 10,
    maxToolCalls: 20,
    maxToolRounds: 8,
    updatedAt: "2026-08-17T00:00:00.000Z",
    updatedBy: null,
    version: 3
  }
};

afterEach(() => vi.unstubAllGlobals());

describe("administrator tool limits task", () => {
  it("saves values such as 200 without rendering an upper bound", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ modelPolicy: catalog }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        modelPolicy: {
          ...catalog,
          policy: { ...catalog.policy, maxToolCalls: 200, maxToolRounds: 200, version: 4 }
        }
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminProviderRunLimitsTask active />);
    const rounds = await screen.findByLabelText("Maximum tool rounds");
    const calls = screen.getByLabelText("Maximum tool calls");
    expect(rounds).not.toHaveAttribute("max");
    expect(calls).not.toHaveAttribute("max");
    fireEvent.change(rounds, { target: { value: "200" } });
    fireEvent.change(calls, { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));

    expect(await screen.findByText("Tool limits updated.")).toBeVisible();
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      expectedVersion: 3,
      mcpAutoDiscoveryTimeoutSeconds: 60,
      maxMcpToolsPerDiscovery: 10,
      maxToolCalls: 200,
      maxToolRounds: 200
    });
  });

  it("does not submit zero or fractional values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ modelPolicy: catalog }), { status: 200 })
    ));
    render(<AdminProviderRunLimitsTask active />);
    const calls = await screen.findByLabelText("Maximum tool calls");
    fireEvent.change(calls, { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "Save limits" })).toBeDisabled();
    fireEvent.change(calls, { target: { value: "1.5" } });
    expect(screen.getByRole("button", { name: "Save limits" })).toBeDisabled();
  });
});
