import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminProviderSystemModelTask } from "./AdminProviderSystemModelTask";

const candidate = {
  connectionDisplayName: "Provider A",
  connectionId: "connection-a",
  defaultReasoningEffort: "medium",
  displayName: "Model A",
  id: "model-a",
  reasoningEfforts: ["low", "medium", "high", "xhigh"],
  structuredOutput: "not_verified" as const
};

const rerankerCandidate = {
  connectionDisplayName: "OpenRouter",
  connectionId: "connection-reranker",
  displayName: "Qwen3 Reranker 8B",
  id: "reranker-a"
};

const catalog = {
  candidates: [candidate],
  rerankerCandidates: [],
  policy: {
    reasoningEffort: null,
    rerankerModel: null,
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
  it("selects a dedicated Memory reranker independently from the system model", async () => {
    const initial = {
      ...catalog,
      rerankerCandidates: [rerankerCandidate]
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ systemModelPolicy: initial }),
        { status: 200 }
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        systemModelPolicy: {
          ...initial,
          policy: {
            ...initial.policy,
            rerankerModel: { ...rerankerCandidate, available: true },
            version: 2
          }
        }
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminProviderSystemModelTask active />);
    fireEvent.change(await screen.findByLabelText(
      "Dedicated Memory reranker deployment"
    ), { target: { value: "reranker-a" } });
    fireEvent.click(screen.getByRole("button", { name: "Save utility models" }));

    await screen.findByText("Utility model roles updated.");
    expect(screen.getByText(/Memory reranker: OpenRouter \/ Qwen3 Reranker 8B/u))
      .toBeVisible();
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      expectedVersion: 1,
      providerModelId: null,
      reasoningEffort: null,
      rerankerProviderModelId: "reranker-a"
    });
  });

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
    fireEvent.click(screen.getByRole("button", { name: "Save utility models" }));

    await screen.findByText("Utility model roles updated.");
    expect(screen.getByText(/Last saved by Administrator/)).toBeVisible();
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      expectedVersion: 1,
      providerModelId: "model-a",
      rerankerProviderModelId: null,
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
      rerankerCandidates: [],
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
      rerankerCandidates: [],
      policy: {
        rerankerModel: null,
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
    expect(screen.getByText(/MCP Auto: Verification required/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Run verification" })).toBeEnabled();
    const save = screen.getByRole("button", { name: "Save utility models" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await screen.findByText("Utility model roles updated.");
    expect(screen.getByText(/Last saved by Current administrator/)).toBeVisible();
  });

  it("verifies the current supported model with one explicit provider request", async () => {
    const current = {
      candidates: [candidate],
      rerankerCandidates: [],
      policy: {
        ...catalog.policy,
        systemModel: { ...candidate, available: true }
      }
    };
    const verified = {
      candidates: [{ ...candidate, structuredOutput: "verified" as const }],
      rerankerCandidates: [],
      policy: {
        ...current.policy,
        systemModel: {
          ...candidate,
          available: true,
          structuredOutput: "verified" as const
        }
      }
    };
    const onMutationCommitted = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ systemModelPolicy: current }),
        { status: 200 }
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ systemModelPolicy: verified }),
        { status: 200 }
      ));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminProviderSystemModelTask active onMutationCommitted={onMutationCommitted} />);
    expect(await screen.findByText(/MCP Auto: Verification required/)).toBeVisible();
    expect(screen.getByText(/one small model request.*provider charges/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Run verification" }));

    await screen.findByText("Structured output verified. MCP Auto is ready.");
    expect(screen.getByText(/MCP Auto: Ready/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Run verification" })).not.toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/admin/providers/system-model-policy");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ providerModelId: "model-a" });
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalled());
  });

  it("reports verified structured output without another paid action", async () => {
    const verified = {
      candidates: [{ ...candidate, structuredOutput: "verified" as const }],
      rerankerCandidates: [],
      policy: {
        ...catalog.policy,
        systemModel: {
          ...candidate,
          available: true,
          structuredOutput: "verified" as const
        }
      }
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ systemModelPolicy: verified }), { status: 200 })
    ));

    render(<AdminProviderSystemModelTask active />);
    expect(await screen.findByText(/MCP Auto: Ready/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Run verification" })).not.toBeInTheDocument();
  });

  it("does not let verification discard an unsaved system-model draft", async () => {
    const current = {
      candidates: [candidate],
      rerankerCandidates: [],
      policy: {
        ...catalog.policy,
        systemModel: { ...candidate, available: true }
      }
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ systemModelPolicy: current }), { status: 200 })
    ));

    render(<AdminProviderSystemModelTask active />);
    const verification = await screen.findByRole("button", { name: "Run verification" });
    expect(verification).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Reasoning effort"), {
      target: { value: "low" }
    });
    expect(verification).toBeDisabled();
  });

  it("explains unsupported adapters without offering verification", async () => {
    const unsupported = {
      candidates: [{ ...candidate, structuredOutput: "unsupported" as const }],
      rerankerCandidates: [],
      policy: {
        ...catalog.policy,
        systemModel: {
          ...candidate,
          available: true,
          structuredOutput: "unsupported" as const
        }
      }
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ systemModelPolicy: unsupported }), { status: 200 })
    ));

    render(<AdminProviderSystemModelTask active />);
    expect(await screen.findByText(/MCP Auto: Not supported by this adapter/)).toBeVisible();
    expect(screen.getByText(/Supported paths are OpenAI Responses/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Run verification" })).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Save utility models" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(
      "The system model changed elsewhere"
    ));
  });
});
