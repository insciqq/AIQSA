import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import {
  fixtureConnection,
  fixtureCredential,
  fixtureModel,
  workingConnection
} from "@/components/admin/providers/providerFixtures";
import type {
  AdminOpenRouterDiscoveredEndpoint,
  AdminOpenRouterDiscoveredModel
} from "@/lib/contracts/adminProviders";
import { AdminProviderModelSheet } from "./AdminProviderModelSheet";
import type { AdminOpenRouterDiscoverySession, OpenRouterDiscoveryState } from "./useAdminOpenRouterDiscovery";

const catalogModels: AdminOpenRouterDiscoveredModel[] = [
  {
    contextLength: 1_000_000,
    id: "anthropic/claude-sonnet-5",
    inputModalities: ["text", "image"],
    name: "Anthropic: Claude Sonnet 5",
    outputModalities: ["text"],
    pricing: {},
    supportedParameters: ["tools", "reasoning"]
  },
  {
    contextLength: 200_000,
    id: "google/gemini-3.5-flash",
    inputModalities: ["text"],
    name: "Google: Gemini 3.5 Flash",
    outputModalities: ["text"],
    pricing: {},
    supportedParameters: ["tools"]
  }
];

const endpoints: AdminOpenRouterDiscoveredEndpoint[] = [
  { name: "Anthropic | claude-sonnet-5", providerName: "Anthropic", supportedParameters: [], tag: "anthropic" },
  { name: "Amazon Bedrock | claude-sonnet-5", providerName: "Amazon Bedrock · US", quantization: "fp8", supportedParameters: [], tag: "amazon-bedrock" }
];

function ready<T>(items: readonly T[]): OpenRouterDiscoveryState<T> {
  return { error: null, items, status: items.length ? "success" : "empty" };
}

function discovery(): AdminOpenRouterDiscoverySession {
  return {
    compatibleModels: { get: () => ready([]), load: async () => [], refresh: async () => [], retry: async () => [] },
    endpoints: {
      get: (identity) => identity ? ready(endpoints) : ready([]),
      load: async () => endpoints,
      refresh: async () => endpoints,
      retry: async () => endpoints
    },
    models: {
      get: (identity) => identity ? ready(catalogModels) : ready([]),
      load: async () => catalogModels,
      refresh: async () => catalogModels,
      retry: async () => catalogModels
    }
  };
}

function controller(saveModel: Mock = vi.fn(async () => ({ ok: true as const }))) {
  return {
    actions: { saveModel },
    state: { busy: false }
  } as unknown as AdminProvidersController;
}

describe("AdminProviderModelSheet", () => {
  it("adds an OpenRouter model from the catalog with an ordered route and one Test & Save", async () => {
    const connection = fixtureConnection({
      credentials: [fixtureCredential({ id: "cred-primary", label: "Primary" })],
      defaultCredentialId: "cred-primary",
      displayName: "OpenRouter",
      family: "openrouter",
      id: "conn-or"
    });
    const saveModel = vi.fn(async () => ({ ok: true as const }));
    const onSaved = vi.fn();
    render(
      <AdminProviderModelSheet
        connection={connection}
        controller={controller(saveModel)}
        discovery={discovery()}
        model={null}
        onClose={vi.fn()}
        onSaved={onSaved}
        open
      />
    );

    const sheet = await screen.findByRole("dialog", { name: "Add model" });
    expect(sheet).toHaveAccessibleDescription("OpenRouter · checked with key Primary");
    expect(within(sheet).getByText("Checks the model with key Primary, then turns it on")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Test & Save" })).toBeDisabled();
    expect(within(sheet).getByRole("switch", { name: "Available in chat" })).toBeChecked();
    expect(within(sheet).queryByText("Response timeout (seconds)")).not.toBeVisible();

    fireEvent.click(within(sheet).getByRole("button", { name: "Model" }));
    fireEvent.click(await screen.findByRole("option", { name: /Claude Sonnet 5/ }));
    expect(within(sheet).getByLabelText("Display name")).toHaveValue("Anthropic: Claude Sonnet 5");
    expect(sheet).toHaveTextContent("1M context · tools, reasoning, image input");

    fireEvent.click(within(sheet).getByLabelText(/Only these providers/));
    const routing = await within(sheet).findByTestId("model-routing-list");
    expect(within(routing).getByPlaceholderText(/Add provider · Amazon Bedrock · US, Anthropic…/)).toBeInTheDocument();
    fireEvent.click(await within(routing).findByRole("button", { name: /^Anthropic/ }));
    fireEvent.click(within(routing).getByRole("button", { name: /Amazon Bedrock · US/ }));
    const ordered = within(routing).getByRole("list", { name: "Providers in order" });
    expect(within(ordered).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "1Anthropicanthropic",
      "2Amazon Bedrock · USamazon-bedrock"
    ]);
    expect(routing).not.toHaveTextContent("fp8");
    fireEvent.click(within(ordered).getByRole("button", { name: "Move Amazon Bedrock · US up" }));
    expect(within(ordered).getAllByRole("listitem")[0]).toHaveTextContent("Amazon Bedrock · US");

    fireEvent.change(within(sheet).getByLabelText("Display name"), { target: { value: "Claude Sonnet 5" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Test & Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(saveModel).toHaveBeenCalledOnce();
    expect(saveModel).toHaveBeenCalledWith("conn-or", null, {
      configuration: expect.objectContaining({
        adapterKind: "openrouter_chat_completions",
        answerSelectable: true,
        capabilities: expect.objectContaining({ toolCalling: true, vision: true }),
        modelClass: "answer",
        openRouterRouting: { mode: "only_selected", providers: ["amazon-bedrock", "anthropic"] },
        upstreamModelId: "anthropic/claude-sonnet-5"
      }),
      displayName: "Claude Sonnet 5"
    });
    expect(sheet).not.toHaveTextContent(/draft|revision|pending|evidence|probe|adapter|fingerprint/iu);
  });

  it("edits an OpenAI model, shows the server failure inline, and asks before discarding changes", async () => {
    const connection = workingConnection();
    const model = connection.models[0]!;
    const saveModel = vi.fn(async () => ({
      error: { blockers: [], code: "provider_draft_stale", resourceIds: [] },
      message: "This provider changed in another window. Refresh and try again.",
      ok: false as const
    }));
    const onClose = vi.fn();
    render(
      <AdminProviderModelSheet
        connection={connection}
        controller={controller(saveModel)}
        discovery={discovery()}
        model={model}
        onClose={onClose}
        onSaved={vi.fn()}
        open
      />
    );

    const sheet = await screen.findByRole("dialog", { name: "Edit model" });
    const modelField = within(sheet).getByRole("combobox", { name: "Model" });
    expect(modelField).toHaveValue("gpt-5.6-terra");
    expect(within(sheet).queryByText("Routing")).not.toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Test & Save" })).toBeDisabled();

    fireEvent.click(within(sheet).getByText(/^Advanced/));
    expect(within(sheet).getByLabelText("Response timeout (seconds)")).toBeVisible();
    expect(within(sheet).getByRole("switch", { name: "Tools" })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("switch", { name: "Image input" }));
    fireEvent.change(within(sheet).getByLabelText("Response timeout (seconds)"), { target: { value: "120" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Test & Save" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("This provider changed in another window.");
    expect(saveModel).toHaveBeenCalledWith("conn-openai", "model-terra", {
      configuration: expect.objectContaining({
        capabilities: expect.objectContaining({ vision: true }),
        responseTimeoutSeconds: 120,
        upstreamModelId: "gpt-5.6-terra"
      }),
      displayName: "GPT-5.6 Terra",
      expectedDraftVersion: 1
    });

    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    const discard = await screen.findByTestId("provider-model-discard");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(discard).getByRole("button", { name: "Confirm discard changes" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("offers built-in ids as hints and saves without a check when no key is usable", async () => {
    const connection = fixtureConnection({ displayName: "Anthropic", family: "anthropic", id: "conn-anthropic" });
    render(
      <AdminProviderModelSheet
        connection={connection}
        controller={controller()}
        discovery={discovery()}
        model={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        open
      />
    );
    const sheet = await screen.findByRole("dialog", { name: "Add model" });
    expect(sheet).toHaveAccessibleDescription("Anthropic · no default key yet");
    expect(sheet).toHaveTextContent("Turns the model on without a check");
    const input = within(sheet).getByRole("combobox", { name: "Model" });
    const hints = [...document.querySelectorAll("datalist option")].map((option) => option.getAttribute("value"));
    expect(hints).toContain("claude-sonnet-5");
    fireEvent.change(input, { target: { value: "claude-sonnet-5" } });
    expect(within(sheet).getByLabelText("Display name")).toHaveValue("Claude Sonnet 5");
    expect(within(sheet).getByRole("button", { name: "Test & Save" })).toBeEnabled();
  });
});
