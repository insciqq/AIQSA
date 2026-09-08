import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminProviderAddSheet } from "./AdminProviderAddSheet";
import { fixtureConnection, workingConnection } from "../providerFixtures";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";

const checkedAt = "2026-09-07T12:51:00.000Z";
const forbiddenWords = /\b(version|revision|draft|pending|probe|evidence|fingerprint|adapter|CAS)\b/iu;

function snapshot() {
  const provider = (id: string, label: string, models: string[]) => ({
    candidateModels: models.map((displayName) => ({ displayName })),
    provider: id,
    providerDisplayName: label,
    stateToken: `state-${id}`
  });
  return {
    providers: [
      provider("openai", "OpenAI", ["GPT-5.6 Terra", "GPT-5.6 Luna", "GPT-5.6 Sol"]),
      provider("anthropic", "Anthropic", ["Claude Opus 5", "Claude Sonnet 5"]),
      provider("gemini", "Gemini", ["Gemini 3.6 Flash"]),
      provider("deepseek", "DeepSeek", ["DeepSeek V4 Pro"]),
      provider("openrouter", "OpenRouter", ["Claude Opus 4.8"])
    ]
  };
}

function ready(connectionId: string) {
  return {
    checkedAt,
    connectionId,
    defaultCredentialChanged: true,
    defaultChanged: false,
    model: { displayName: "GPT-5.6 Terra" },
    models: [{ displayName: "GPT-5.6 Terra" }, { displayName: "GPT-5.6 Luna" }],
    outcome: "ready",
    provider: "openai",
    providerDisplayName: "OpenAI",
    search: null
  };
}

type Call = { body: Record<string, unknown> | null; method: string; url: string };
type Router = (call: Call) => Response | null | undefined;

function mockFetch(router: Router = () => null) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    const call = { body, method, url };
    calls.push(call);
    const routed = router(call);
    if (routed) return routed;
    if (url === "/api/admin/providers/quick-setup" && method === "GET") return Response.json(snapshot());
    return Response.json({ error: "unexpected_request" }, { status: 500 });
  });
  return calls;
}

function renderSheet(connections: AdminProviderConnection[] = []) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(<AdminProviderAddSheet connections={connections} onClose={onClose} onCreated={onCreated} open />);
  return { onClose, onCreated };
}

async function sheet() {
  return screen.findByRole("dialog", { name: "Add provider" });
}

describe("AdminProviderAddSheet", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the six tiles, the recommended models and one Test & Save with its paid caption", async () => {
    mockFetch();
    renderSheet();
    const dialog = await sheet();
    const tiles = within(dialog).getByTestId("provider-add-tiles");
    expect(within(tiles).getAllByRole("button").map((tile) => tile.getAttribute("data-testid"))).toEqual([
      "provider-add-tile-openai",
      "provider-add-tile-anthropic",
      "provider-add-tile-gemini",
      "provider-add-tile-deepseek",
      "provider-add-tile-openrouter",
      "provider-add-tile-custom"
    ]);
    expect(within(tiles).getByRole("button", { name: /^Custom/ })).toHaveTextContent("OpenAI-compatible");
    expect(within(tiles).getByRole("button", { name: "OpenAI" })).not.toHaveTextContent("compatible");
    expect(within(tiles).getByRole("button", { name: "OpenAI" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("OpenAI");
    expect(within(dialog).getByLabelText("Name")).not.toBeRequired();
    expect(within(dialog).queryByTestId("provider-add-second-hint")).not.toBeInTheDocument();
    const summary = await within(dialog).findByTestId("provider-add-summary");
    expect(summary).toHaveTextContent("Verifies the key and turns on GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.6 Sol");
    expect(summary).toHaveTextContent("Makes this key the default for everyone on this connection");
    expect(within(dialog).getByRole("button", { name: "Test & Save" })).toBeInTheDocument();
    expect(within(dialog).getByText("Checks supported models and Search, then fills empty roles, including Knowledge. Assigned PDF readers receive page images and text. Uses small paid requests.")).toBeInTheDocument();
    expect(within(dialog).getByText("Advanced · endpoint, timeout, private network")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Endpoint")).toHaveValue("https://api.openai.com/v1");
    expect(dialog.textContent).not.toMatch(forbiddenWords);

    fireEvent.click(within(tiles).getByRole("button", { name: "Anthropic" }));
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Anthropic");
    expect(within(dialog).getByTestId("provider-add-summary")).toHaveTextContent("Claude Opus 5, Claude Sonnet 5");
    expect(within(dialog).getByLabelText("Endpoint")).toHaveValue("https://api.anthropic.com/v1");
  });

  it("adds a built-in provider with one quick-setup call and hands over the new connection", async () => {
    const calls = mockFetch(({ method, url }) => {
      if (method === "POST" && url === "/api/admin/providers/quick-setup") {
        return Response.json(ready("00000000-0000-4000-8000-000000001102"));
      }
      return null;
    });
    const { onCreated } = renderSheet();
    const dialog = await sheet();
    await within(dialog).findByText(/GPT-5.6 Terra, GPT-5.6 Luna/);
    fireEvent.change(within(dialog).getByLabelText("API key"), { target: { value: "sk-new-key" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Test & Save" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("00000000-0000-4000-8000-000000001102"));
    const posts = calls.filter(({ method }) => method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      body: {
        connectionDisplayName: "OpenAI",
        expectedState: "state-openai",
        provider: "openai",
        secret: "sk-new-key"
      },
      url: "/api/admin/providers/quick-setup"
    });
    expect(posts[0]!.body).not.toHaveProperty("configuration");
    // The sheet stays locked until the caller opens the new page.
    expect(within(dialog).getByRole("button", { name: "Test & Save" })).toBeDisabled();
    expect(dialog.textContent).not.toContain("sk-new-key");
  });

  it("requires a distinct name for a second connection of the family and sends endpoint overrides", async () => {
    const calls = mockFetch(({ method, url }) => {
      if (method === "POST" && url === "/api/admin/providers/quick-setup") {
        return Response.json(ready("connection-second"));
      }
      return null;
    });
    const { onCreated } = renderSheet([workingConnection()]);
    const dialog = await sheet();
    expect(within(dialog).getByTestId("provider-add-second-hint")).toHaveTextContent(
      "OpenAI is already connected. This adds a second OpenAI connection, for example for another account."
    );
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveValue("OpenAI · 2");
    expect(name).toBeRequired();
    await within(dialog).findByText(/GPT-5.6 Terra, GPT-5.6 Luna/);

    fireEvent.change(name, { target: { value: " openai " } });
    fireEvent.change(within(dialog).getByLabelText("API key"), { target: { value: "sk-second" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Test & Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Another provider already has this name.");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(0);

    fireEvent.change(name, { target: { value: "OpenAI · Research account" } });
    fireEvent.change(within(dialog).getByLabelText("Endpoint"), { target: { value: "https://gateway.example.test/v1" } });
    fireEvent.change(within(dialog).getByLabelText("Response timeout (seconds)"), { target: { value: "120" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Test & Save" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("connection-second"));
    expect(calls.filter(({ method }) => method === "POST").at(-1)?.body).toEqual({
      configuration: {
        allowPrivateNetwork: false,
        apiRoot: "https://gateway.example.test/v1",
        responseTimeoutSeconds: 120
      },
      connectionDisplayName: "OpenAI · Research account",
      expectedState: "state-openai",
      provider: "openai",
      secret: "sk-second"
    });
  });

  it("keeps the fields on a rejected key and lets the admin choose a model when the key needs one", async () => {
    let posts = 0;
    const calls = mockFetch(({ method, url }) => {
      if (method === "POST" && url === "/api/admin/providers/quick-setup") {
        posts += 1;
        if (posts === 1) return Response.json({ error: "provider_credential_test_failed" }, { status: 422 });
        if (posts === 2) {
          return Response.json({
            candidates: [
              { candidateId: "p2-o2", displayName: "GPT-5.6 Luna" },
              { candidateId: "p2-o3", displayName: "GPT-5.6 Sol" }
            ],
            checkedAt,
            expectedState: "state-openai-picker",
            outcome: "selection_required",
            policyVersion: 6,
            provider: "openai",
            providerDisplayName: "OpenAI"
          });
        }
        return Response.json(ready("00000000-0000-4000-8000-000000001102"));
      }
      return null;
    });
    const { onCreated } = renderSheet();
    const dialog = await sheet();
    await within(dialog).findByText(/GPT-5.6 Terra, GPT-5.6 Luna/);
    const key = within(dialog).getByLabelText("API key");
    fireEvent.change(key, { target: { value: "sk-limited" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Test & Save" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The provider rejected the key or its account catalog could not be reached."
    );
    expect(key).toHaveValue("sk-limited");
    expect(key).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByRole("button", { name: "Test & Save" })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Test & Save" }));
    const picker = await within(dialog).findByTestId("provider-add-selection");
    expect(picker).toHaveTextContent("Choose a model available to this key");
    expect(within(dialog).getByRole("button", { name: "Test & Save" })).toBeDisabled();
    fireEvent.click(within(picker).getByLabelText("GPT-5.6 Sol"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Test & Save" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(calls.filter(({ method }) => method === "POST").at(-1)?.body).toEqual({
      connectionDisplayName: "OpenAI",
      expectedState: "state-openai-picker",
      provider: "openai",
      secret: "sk-limited",
      selectedModel: { candidateId: "p2-o3", policyVersion: 6 }
    });
    expect(dialog.textContent).not.toMatch(forbiddenWords);
  });

  it("discovers a custom endpoint's models, then tests and saves the chosen ones", async () => {
    const calls = mockFetch(({ body, method, url }) => {
      if (method === "POST" && url === "/api/admin/providers/custom-setup/discover") {
        return Response.json({
          checkedAt,
          modelCount: 4,
          models: [
            { capabilities: { contextWindow: 128_000, reasoning: true }, id: "gpt-5.6-terra" },
            { capabilities: {}, id: "gpt-5.6-luna" },
            { capabilities: {}, id: "text-embedding-3-large" },
            { capabilities: {}, id: "whisper-1" }
          ],
          source: "models_catalog",
          status: "valid"
        });
      }
      if (method === "POST" && url === "/api/admin/providers/custom-setup") {
        const modelIds = body?.modelIds as string[];
        return Response.json({
          authenticationMode: "bearer",
          checkedAt,
          connectionDisplayName: body?.connectionDisplayName,
          connectionId: "connection-custom",
          defaultChanged: false,
          modelDisplayName: modelIds[0],
          models: modelIds.map((id, index) => ({ modelDisplayName: id, providerModelId: `model-${index}` })),
          outcome: "ready",
          providerModelId: "model-0",
          search: null
        });
      }
      return null;
    });
    const { onCreated } = renderSheet([fixtureConnection({ displayName: "Custom · codex-lb.example.test", family: "openai_compatible", id: "conn-custom" })]);
    const dialog = await sheet();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Custom/ }));
    expect(within(dialog).getByRole("button", { name: "Test & Save" })).toBeDisabled();
    expect(within(dialog).getByText("Checks supported models and Search, then fills empty roles, including Knowledge. Assigned PDF readers receive page images and text. Uses small paid requests.")).toBeInTheDocument();
    expect(within(dialog).getByText("Advanced · timeout, private network, reasoning mapping")).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("Base URL"), { target: { value: "https://codex-lb.example.test/v1" } });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Custom · codex-lb.example.test");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "codex-lb · Research" } });
    fireEvent.change(within(dialog).getByLabelText("API key"), { target: { value: "sk-custom" } });
    fireEvent.change(within(dialog).getByLabelText("API style"), { target: { value: "responses" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Find models" }));

    const models = await within(dialog).findByTestId("provider-add-models");
    expect(within(dialog).getByText("Models found on this endpoint · 4")).toBeInTheDocument();
    expect(within(models).getByLabelText(/gpt-5.6-terra/)).toBeEnabled();
    expect(models).toHaveTextContent("reasoning · 128k context");
    expect(within(models).getByLabelText(/text-embedding-3-large/)).toBeDisabled();
    expect(models).toHaveTextContent("embeddings");
    expect(models).toHaveTextContent("not supported");
    expect(within(dialog).getByRole("button", { name: "Look again" })).toBeInTheDocument();
    expect(calls.find(({ url }) => url.endsWith("/discover"))?.body).toEqual({
      allowPrivateNetwork: false,
      apiRoot: "https://codex-lb.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutSeconds: 300,
      secret: "sk-custom"
    });

    fireEvent.click(within(models).getByLabelText(/gpt-5.6-terra/));
    expect(within(dialog).getByRole("button", { name: "Test & Save 1 model" })).toBeEnabled();
    fireEvent.click(within(models).getByLabelText(/gpt-5.6-luna/));
    fireEvent.click(within(dialog).getByRole("button", { name: "Test & Save 2 models" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("connection-custom"));
    expect(calls.filter(({ url }) => url === "/api/admin/providers/custom-setup")[0]?.body).toMatchObject({
      allowPrivateNetwork: false,
      apiRoot: "https://codex-lb.example.test/v1",
      authenticationMode: "bearer",
      confirmPaidRequest: true,
      connectionDisplayName: "codex-lb · Research",
      modelIds: ["gpt-5.6-terra", "gpt-5.6-luna"],
      protocol: "responses",
      reasoningRequestMapping: { effortPath: "reasoning.effort", modePath: "reasoning.mode" },
      responseTimeoutSeconds: 300,
      secret: "sk-custom"
    });
    expect(dialog.textContent).not.toContain("sk-custom");
    expect(dialog.textContent).not.toMatch(forbiddenWords);
  });

  it("sends the explicit no-key private-network flag and keeps the fields when the endpoint fails its test", async () => {
    const calls = mockFetch(({ method, url }) => {
      if (method === "POST" && url === "/api/admin/providers/custom-setup/discover") {
        return Response.json({
          checkedAt,
          modelCount: 1,
          models: [{ capabilities: {}, id: "local/llama" }],
          source: "models_catalog",
          status: "valid"
        });
      }
      if (method === "POST" && url === "/api/admin/providers/custom-setup") {
        return Response.json({ error: "provider_custom_setup_test_failed" }, { status: 422 });
      }
      return null;
    });
    const { onCreated } = renderSheet();
    const dialog = await sheet();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Custom/ }));
    fireEvent.change(within(dialog).getByLabelText("Base URL"), { target: { value: "http://10.0.0.5:8000/v1" } });
    fireEvent.click(within(dialog).getByLabelText("This endpoint needs no key (private network)"));
    expect(within(dialog).getByLabelText("API key")).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Find models" }));
    await within(dialog).findByTestId("provider-add-models");
    // The single supported model is chosen for the admin.
    expect(within(dialog).getByLabelText(/local\/llama/)).toBeChecked();
    expect(calls.find(({ url }) => url.endsWith("/discover"))?.body).toEqual({
      allowPrivateNetwork: true,
      apiRoot: "http://10.0.0.5:8000/v1",
      authenticationMode: "none",
      responseTimeoutSeconds: 300
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Test & Save 1 model" }));
    expect(await within(dialog).findByTestId("provider-add-error")).toHaveTextContent(
      "The endpoint did not complete the exact model test."
    );
    expect(within(dialog).getByLabelText("Base URL")).toHaveValue("http://10.0.0.5:8000/v1");
    expect(within(dialog).getByLabelText(/local\/llama/)).toBeChecked();
    expect(onCreated).not.toHaveBeenCalled();
    const setup = calls.find(({ url }) => url === "/api/admin/providers/custom-setup")?.body;
    expect(setup).toMatchObject({
      allowPrivateNetwork: true,
      apiRoot: "http://10.0.0.5:8000/v1",
      authenticationMode: "none",
      connectionDisplayName: "Custom · 10.0.0.5",
      modelIds: ["local/llama"],
      protocol: "chat_completions"
    });
    expect(setup).not.toHaveProperty("secret");
  });

  it("asks before discarding typed input and closes directly when nothing changed", async () => {
    mockFetch();
    const { onClose } = renderSheet();
    const dialog = await sheet();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.change(within(dialog).getByLabelText("API key"), { target: { value: "sk-typed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    const discard = await screen.findByRole("dialog", { name: "Discard unsaved provider" });
    fireEvent.click(within(discard).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Discard unsaved provider" }))
      .getByRole("button", { name: "Confirm discard changes" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
