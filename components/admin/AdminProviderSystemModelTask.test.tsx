import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminProviderSystemModelTask } from "./AdminProviderSystemModelTask";

const candidate = {
  connectionDisplayName: "Provider A",
  connectionId: "connection-a",
  defaultReasoningEffort: "medium",
  displayName: "Model A",
  id: "model-a",
  reasoningEfforts: ["low", "medium", "high", "xhigh"]
};

const catalog = {
  candidates: [candidate],
  policy: {
    reasoningEffort: null,
    systemModel: null,
    updatedAt: "2026-08-08T00:00:00.000Z",
    updatedBy: null,
    version: 1
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("administrator provider system model task", () => {
  it("saves one exact deployment with the observed policy version", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ systemModelPolicy: catalog }),
        { status: 200 }
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        systemModelPolicy: {
          ...catalog,
          policy: {
            ...catalog.policy,
            reasoningEffort: "xhigh",
            systemModel: { ...candidate, available: true },
            updatedBy: { displayName: "Administrator", id: "admin-1" },
            version: 2
          }
        }
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminProviderSystemModelTask active />);
    const select = await screen.findByLabelText("Active answer model deployment");
    fireEvent.change(select, { target: { value: "model-a" } });
    expect(screen.getByLabelText("Reasoning effort")).toHaveValue("xhigh");
    fireEvent.click(screen.getByRole("button", { name: "Save system model" }));

    await screen.findByText("System model updated.");
    expect(screen.getByText(/Last saved by Administrator/)).toBeVisible();
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      expectedVersion: 1,
      providerModelId: "model-a",
      reasoningEffort: "xhigh"
    });
  });

  it("distinguishes an unavailable current connection from a same-name candidate", async () => {
    const unavailableCurrent = { ...candidate, available: false };
    const duplicateCatalog = {
      candidates: [{
        ...candidate,
        connectionDisplayName: " provider a ",
        connectionId: "connection-b",
        id: "model-b"
      }],
      policy: {
        ...catalog.policy,
        reasoningEffort: null,
        systemModel: unavailableCurrent
      }
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ systemModelPolicy: duplicateCatalog }), { status: 200 })
    ));

    render(<AdminProviderSystemModelTask active />);
    const select = await screen.findByLabelText("Active answer model deployment");
    const optionLabels = Array.from((select as HTMLSelectElement).options)
      .map(({ textContent }) => textContent ?? "")
      .filter((label) => label.includes("Model A"));

    expect(optionLabels).toEqual([
      expect.stringMatching(/^Unavailable — Provider A · ref [0-9A-Z]{6,} \/ Model A$/u),
      expect.stringMatching(/^ provider a  · ref [0-9A-Z]{6,} \/ Model A$/u)
    ]);
    expect(optionLabels[0]).not.toBe(optionLabels[1]);
  });

  it("shows retained unavailability and permits re-saving the same deployment", async () => {
    const unavailable = {
      candidates: [candidate],
      policy: {
        systemModel: { ...candidate, available: false },
        reasoningEffort: "xhigh",
        updatedAt: "2026-08-08T00:00:00.000Z",
        updatedBy: { displayName: "Former administrator", id: "admin-old" },
        version: 4
      }
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ systemModelPolicy: unavailable }),
        { status: 200 }
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        systemModelPolicy: {
          ...unavailable,
          policy: {
            ...unavailable.policy,
            reasoningEffort: "xhigh",
            systemModel: { ...candidate, available: true },
            updatedBy: { displayName: "Current administrator", id: "admin-new" },
            version: 5
          }
        }
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminProviderSystemModelTask active />);
    expect(await screen.findByText(/Status: Unavailable/)).toBeVisible();
    const save = screen.getByRole("button", { name: "Save system model" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await screen.findByText("System model updated.");
    expect(screen.getByText(/Last saved by Current administrator/)).toBeVisible();
  });

  it("keeps a stale edit visible and actionable", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ systemModelPolicy: catalog }),
        { status: 200 }
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: "system_model_policy_stale" }),
        { status: 409 }
      ));
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminProviderSystemModelTask active />);
    fireEvent.change(await screen.findByLabelText("Active answer model deployment"), {
      target: { value: "model-a" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save system model" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(
      "The system model changed elsewhere"
    ));
  });
});
