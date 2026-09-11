import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { adminKnowledgeProfileFixture, adminKnowledgeSettingsFixture } from "@/tests/support/knowledgeProfile";
import type { AdminGroup } from "@/lib/contracts/admin";
import type { AdminKnowledgeSettings } from "@/lib/contracts/adminKnowledge";
import type { AdminModelPolicyCatalog } from "@/lib/contracts/adminModelPolicy";
import type { AdminSystemModelPolicyCatalog } from "@/lib/contracts/adminSystemModelPolicy";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminConfirmationRequest } from "../useAdminConfirmationController";
import type { AdminFeedbackNoticeAction } from "../useAdminFeedback";
import { AdminRolesSection } from "./AdminRolesSection";

const base = {
  connectionDisplayName: "OpenAI", connectionId: "openai", defaultReasoningEffort: "medium",
  forcedToolCall: "verified" as const, reasoningEfforts: ["low", "medium", "high"],
  structuredOutput: "verified" as const, visionInput: "not_verified" as const
};
const luna = { ...base, displayName: "GPT Luna", id: "luna" };
const terra = { ...base, displayName: "GPT Terra", forcedToolCall: "not_verified" as const, id: "terra", structuredOutput: "not_verified" as const };
const claude = { ...base, connectionDisplayName: "Anthropic", connectionId: "anthropic", displayName: "Claude", forcedToolCall: "unsupported" as const, id: "claude", structuredOutput: "unsupported" as const };
const titleModel = { ...luna, displayName: "Small title model", id: "title-model", forcedToolCall: "unsupported" as const, reasoningEfforts: ["none", "low", "medium"] };
const voyage = { connectionDisplayName: "OpenRouter", connectionId: "openrouter", displayName: "Voyage Rerank", id: "voyage" };
const cohere = { ...voyage, displayName: "Cohere 4 Pro", id: "cohere" };

function rolesCatalog(): AdminSystemModelPolicyCatalog {
  return {
    candidates: [luna],
    titleCandidates: [titleModel], documentCandidates: [],
    ineligible: { chat_titles: [],
      direct_pdf: [],
      memory: [{ ...terra, reason: "not_checked" }, { ...claude, reason: "adapter_unsupported" }],
      vision: [{ ...luna, reason: "not_checked" }, { ...terra, reason: "not_checked" }, { ...claude, reason: "adapter_unsupported" }]
    },
    policy: {
      chatTitleModel: null, chatTitleReasoningEffort: null, chatPdfModel: null, chatPdfReasoningEffort: null, reasoningEffort: null,
      rerankerModel: { ...voyage, available: true },
      rerankerRoute: {
        entries: [
          { ...voyage, available: true, position: 0, relevanceScoreFloor: null, role: "primary" },
          { ...cohere, available: true, position: 1, relevanceScoreFloor: null, role: "fallback" }
        ],
        policyVersion: "openrouter-reranker-route-v1"
      },
      systemModel: { ...luna, available: true },
      updatedAt: "2026-09-07T00:00:00.000Z", updatedBy: null, version: 1
    },
    rerankerCandidates: [voyage, cohere],
    verificationCandidates: [luna, terra, claude]
  };
}

function modelCatalog(): AdminModelPolicyCatalog {
  const candidate = { connectionDisplayName: "OpenAI", connectionId: "openai", defaultReasoningEffort: "medium", displayName: "GPT Luna", id: "luna", reasoningEfforts: ["low", "medium", "high"] };
  return {
    candidates: [candidate, { ...candidate, displayName: "GPT Terra", id: "terra" }],
    policy: {
      defaultModel: { ...candidate, available: true }, maxMcpToolsPerDiscovery: 12, maxToolCalls: 24, maxToolRounds: 8,
      mcpAutoDiscoveryTimeoutSeconds: 20, mcpAutoDiscoveryMaxOutputTokens: 8192, reasoningEffort: "medium", updatedAt: "2026-09-07T00:00:00.000Z", updatedBy: null, version: 4
    }
  };
}

const groups: AdminGroup[] = [{
  accessGrants: [{ enabled: true, groupId: "g1", id: "grant-1", modelId: null, provider: "openai", searchStrategy: null, userId: null }],
  archivedAt: null, deletion: { canDelete: true, reason: null, summary: "" }, id: "g1", name: "everyone", systemRole: null, userCount: 1
}];

const alternateEmbedding = {
  connectionDisplayName: "OpenRouter", deploymentId: "qwen", modelDisplayName: "Qwen3 Embedding 8B", provider: "openrouter", targetDimension: 1536
};

const documentModel = {
  connectionDisplayName: "OpenAI", defaultReasoningEffort: "medium", deploymentId: "luna",
  directPdf: true, modelDisplayName: "GPT Luna", provider: "openai",
  reasoningEfforts: ["none", "low", "medium", "high"], upstreamModelId: "luna", vision: true
};

function documentSettings(effort: string | null = null): AdminKnowledgeSettings {
  const knowledge = knowledgeSettings();
  const active = { ...knowledge.profile.activeRevision!, pdfProcessing: {
    destination: documentModel, mode: "system_model_vision" as const, parserProfileVersion: 19,
    reasoningEffort: effort
  } };
  return { ...knowledge, profile: { ...knowledge.profile, activeRevision: active,
    availablePdfDestinations: [documentModel, {
      ...documentModel, defaultReasoningEffort: null, deploymentId: "terra",
      modelDisplayName: "GPT Terra", reasoningEfforts: []
    }], recentRevisions: [active, ...knowledge.profile.recentRevisions]
  } };
}

function knowledgeSettings(): AdminKnowledgeSettings {
  const profile = adminKnowledgeProfileFixture();
  const active = { ...profile.activeRevision!, revisionNumber: 2 };
  const earlier = {
    ...profile.activeRevision!, activatedAt: "2026-08-01T00:00:00.000Z", id: "profile-revision-0",
    destination: alternateEmbedding, revisionNumber: 1
  };
  return adminKnowledgeSettingsFixture({
    profile: adminKnowledgeProfileFixture({
      activeRevision: active,
      availableDestinations: [...profile.availableDestinations, alternateEmbedding],
      recentRevisions: [active, earlier]
    })
  });
}

type Call = { body: Record<string, unknown> | null; method: string; url: string };

function server(initialRoles = rolesCatalog(), initialKnowledge = knowledgeSettings()) {
  let roles = initialRoles;
  let model = modelCatalog();
  let knowledge = initialKnowledge;
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ body, method, url });
    if (url === "/api/admin/providers/system-model-policy") {
      if (method === "POST" && body) {
        const id = String(body.providerModelId);
        const checked = roles.verificationCandidates.find((item) => item.id === id)!;
        roles = {
          ...roles,
          candidates: body.role === "memory" ? [...roles.candidates, { ...checked, forcedToolCall: "verified", structuredOutput: "verified" }] : roles.candidates,
          ineligible: { ...roles.ineligible, [String(body.role)]: roles.ineligible[body.role as "memory"].filter((item) => item.id !== id) }
        };
      }
      if (method === "PATCH" && body) {
        if (body.expectedVersion !== roles.policy.version) {
          return Response.json({ error: "system_model_policy_stale" }, { status: 409 });
        }
        const pick = (id: unknown) => [...roles.titleCandidates, ...roles.candidates, ...roles.documentCandidates, ...roles.verificationCandidates].find((item) => item.id === id) ?? null;
        roles = { ...roles, policy: {
          ...roles.policy, version: roles.policy.version + 1,
          ...(Object.hasOwn(body, "chatPdfProcessingMode") ? { chatPdfProcessingMode: body.chatPdfProcessingMode as "prefer_chat_model" | "use_pdf_reader" | "read_page_images" } : {}),
          ...(Object.hasOwn(body, "chatPdfFallbackMethod") ? { chatPdfFallbackMethod: body.chatPdfFallbackMethod as "pdf_reader" | "page_images" } : {}),
          ...(Object.hasOwn(body, "chatPdfNativeProviderModelId") ? {
            chatPdfNativeModel: body.chatPdfNativeProviderModelId ? { ...pick(body.chatPdfNativeProviderModelId)!, available: true } : null,
            chatPdfNativeReasoningEffort: body.chatPdfNativeReasoningEffort as string | null
          } : {}),
          ...(Object.hasOwn(body, "providerModelId") ? {
            reasoningEffort: body.reasoningEffort as string | null,
            systemModel: body.providerModelId ? { ...pick(body.providerModelId)!, available: true } : null
          } : {}),
          ...(Object.hasOwn(body, "rerankerProviderModelId") ? {
            rerankerModel: body.rerankerProviderModelId ? { ...roles.rerankerCandidates.find((item) => item.id === body.rerankerProviderModelId)!, available: true } : null
          } : {}),
          ...(Object.hasOwn(body, "chatTitleProviderModelId") ? {
            chatTitleModel: body.chatTitleProviderModelId ? { ...pick(body.chatTitleProviderModelId)!, available: true } : null,
            chatTitleReasoningEffort: body.chatTitleReasoningEffort as string | null
          } : {}),
          ...(Object.hasOwn(body, "chatPdfProviderModelId") ? {
            chatPdfModel: body.chatPdfProviderModelId ? { ...pick(body.chatPdfProviderModelId)!, available: true } : null,
            chatPdfReasoningEffort: body.chatPdfReasoningEffort as string | null
          } : {})
        } };
      }
      return Response.json({ systemModelPolicy: roles });
    }
    if (url === "/api/admin/providers/model-policy") {
      if (method === "PATCH" && body) {
        model = { ...model, policy: {
          ...model.policy, version: model.policy.version + 1,
          ...(Object.hasOwn(body, "providerModelId") ? {
            defaultModel: body.providerModelId ? { ...model.candidates.find((item) => item.id === body.providerModelId)!, available: true } : null,
            reasoningEffort: body.reasoningEffort as string | null
          } : {}),
          ...(Object.hasOwn(body, "maxToolRounds") ? {
            maxMcpToolsPerDiscovery: Number(body.maxMcpToolsPerDiscovery), maxToolCalls: Number(body.maxToolCalls),
            maxToolRounds: Number(body.maxToolRounds), mcpAutoDiscoveryTimeoutSeconds: Number(body.mcpAutoDiscoveryTimeoutSeconds),
            mcpAutoDiscoveryMaxOutputTokens: Number(body.mcpAutoDiscoveryMaxOutputTokens)
          } : {})
        } };
      }
      return Response.json({ modelPolicy: model });
    }
    if (url === "/api/admin/knowledge") {
      if (method === "PATCH" && body) {
        if (body.expectedVersion !== knowledge.profile.version) {
          return Response.json({ error: "knowledge_profile_stale" }, { status: 409 });
        }
        const destination = knowledge.profile.availableDestinations.find((item) => item.deploymentId === body.deploymentId) ??
          knowledge.profile.recentRevisions.find((item) => item.id === body.revisionId)?.destination;
        if (!destination) return Response.json({ error: "knowledge_profile_input_invalid" }, { status: 400 });
        const activeRevision = {
          ...knowledge.profile.activeRevision!, activatedAt: "2026-09-07T01:00:00.000Z", destination, id: "profile-revision-3", revisionNumber: 3,
          pdfProcessing: body.action === "rollback_profile"
            ? knowledge.profile.recentRevisions.find((item) => item.id === body.revisionId)!.pdfProcessing
            : {
                destination: knowledge.profile.availablePdfDestinations.find((item) => item.deploymentId === body.documentDeploymentId) ?? null,
                mode: body.pdfProcessingMode as "local" | "system_model_vision" | "system_model_direct_pdf",
                parserProfileVersion: 19, reasoningEffort: body.documentReasoningEffort as string | null
              }
        };
        knowledge = adminKnowledgeSettingsFixture({ profile: adminKnowledgeProfileFixture({
          ...knowledge.profile, activeRevision,
          migration: { activeProfileBases: 0, buildingProfileBases: 1, legacyGenerations: 0, profiledGenerations: 1, totalBases: 5 },
          recentRevisions: [activeRevision, ...knowledge.profile.recentRevisions], version: knowledge.profile.version + 1
        }) });
      }
      return Response.json({ knowledge });
    }
    return Response.json({ error: "unexpected_request" }, { status: 500 });
  }));
  return calls;
}

function renderSection(groupList: AdminGroup[] = groups, resource: string | null = null) {
  const reportNotice = vi.fn<(message: string, action?: AdminFeedbackNoticeAction) => void>();
  const reportError = vi.fn();
  const requestConfirmation = vi.fn<(config: AdminConfirmationRequest) => void>();
  const onMutationCommitted = vi.fn();
  render(
    <AdminRolesSection
      groups={groupList}
      resource={resource}
      onMutationCommitted={onMutationCommitted}
      reportError={reportError}
      reportNotice={reportNotice}
      requestConfirmation={requestConfirmation}
    />
  );
  return { onMutationCommitted, reportError, reportNotice, requestConfirmation };
}

const patchesTo = (calls: Call[], url: string) => calls.filter((call) => call.url === url && call.method === "PATCH").map((call) => call.body);

afterEach(() => vi.unstubAllGlobals());

describe("AdminRolesSection", () => {
  it.each([["reranker", "reranker"], ["chat_titles", "chat-titles"]])("focuses the %s system role from an Overview target", async (resource, row) => {
    server();
    renderSection(groups, resource);
    await waitFor(() => expect(screen.getByTestId(`admin-role-${row}`)).toHaveFocus());
  });

  it("preserves edited defaults and Knowledge fields across a background refresh", async () => {
    const calls = server();
    renderSection();
    const rounds = await screen.findByRole("spinbutton", { name: "Rounds" });
    const documents = await screen.findByRole("combobox", { name: "Documents mode" });
    fireEvent.change(rounds, { target: { value: "11" } });
    fireEvent.change(documents, { target: { value: "system_model_vision" } });
    const previousGetCount = calls.filter((call) => call.method === "GET").length;
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(calls.filter((call) => call.method === "GET")).toHaveLength(previousGetCount + 3));
    expect(rounds).toHaveValue(11);
    expect(documents).toHaveValue("system_model_vision");
  });

  it("keeps a committed role when an older background read settles afterward", async () => {
    server();
    renderSection();
    const trigger = await screen.findByRole("button", { name: "Reranking deployment" });
    const original = globalThis.fetch;
    let finishRead!: (response: Response) => void;
    const delayed = new Promise<Response>((resolve) => { finishRead = resolve; });
    let previous!: Response;
    let captured = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init);
      if (!captured && String(input) === "/api/admin/providers/system-model-policy" && (init?.method ?? "GET") === "GET") {
        captured = true;
        previous = response;
        return delayed;
      }
      return response;
    }));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(captured).toBe(true));
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /Cohere 4 Pro/ }));
    await waitFor(() => expect(trigger).toHaveTextContent("Cohere 4 Pro"));
    await act(async () => { finishRead(previous); await delayed; });
    expect(trigger).toHaveTextContent("Cohere 4 Pro");
  });

  it("lists Ready, Check first and Not eligible groups and assigns through Check in one flow", async () => {
    const calls = server();
    const { reportNotice } = renderSection();
    const trigger = await screen.findByRole("button", { name: "System model deployment" });
    expect(trigger).toHaveTextContent("OpenAI / GPT Luna");
    expect(screen.getByTestId("admin-role-memory-status")).toHaveTextContent("Working");
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "System model deployment" });
    expect(within(dialog).getByText("Ready for System model")).toBeInTheDocument();
    expect(within(dialog).getByRole("option", { name: /GPT Luna/ })).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByText("Check first · small paid requests")).toBeInTheDocument();
    expect(within(dialog).getByText("Not eligible")).toBeInTheDocument();
    expect(within(dialog).getByText("required capability unsupported on this route")).toBeInTheDocument();
    expect(within(dialog).queryByRole("option", { name: /Claude|GPT Terra/ })).not.toBeInTheDocument();
    expect(within(dialog).getByText("System roles always use the provider's default key")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Check OpenAI / GPT Terra" }));
    await waitFor(() => expect(trigger).toHaveTextContent("OpenAI / GPT Terra"));
    expect(calls.filter((call) => call.method === "POST").map((call) => call.body))
      .toEqual([{ providerModelId: "terra", role: "memory" }]);
    expect(patchesTo(calls, "/api/admin/providers/system-model-policy"))
      .toEqual([{ expectedVersion: 1, providerModelId: "terra", reasoningEffort: null }]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(reportNotice).toHaveBeenLastCalledWith("Saved for future work", expect.objectContaining({ label: "Undo" }));
  });

  it("applies a selection immediately and Undo restores the previous assignment", async () => {
    const calls = server();
    const { onMutationCommitted, reportNotice } = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Reranking deployment" }));
    fireEvent.click(screen.getByRole("option", { name: /Cohere 4 Pro/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reranking deployment" })).toHaveTextContent("Cohere 4 Pro"));
    expect(patchesTo(calls, "/api/admin/providers/system-model-policy"))
      .toEqual([{ expectedVersion: 1, rerankerProviderModelId: "cohere" }]);
    expect(onMutationCommitted).toHaveBeenCalledTimes(1);

    const [, action] = reportNotice.mock.calls.at(-1)!;
    action!.onSelect();
    await waitFor(() => expect(screen.getByRole("button", { name: "Reranking deployment" })).toHaveTextContent("Voyage Rerank"));
    expect(patchesTo(calls, "/api/admin/providers/system-model-policy").at(-1))
      .toEqual({ expectedVersion: 2, rerankerProviderModelId: "voyage" });
    expect(reportNotice).toHaveBeenLastCalledWith("Previous assignment restored for future work");
    expect(screen.getByTestId("admin-reranker-fallbacks")).toHaveTextContent("Fallbacks: OpenRouter / Cohere 4 Pro");
  });

  it("preserves both reader assignments when changing PDF modes and shows only the applicable fallback", async () => {
    const roles = rolesCatalog();
    const native = { ...luna, id: "native-pdf", displayName: "Native PDF model", pdfInput: "verified" as const };
    const image = { ...luna, id: "page-images", displayName: "Page image model", visionInput: "verified" as const };
    roles.documentCandidates = [native, image];
    roles.policy.chatPdfProcessingMode = "prefer_chat_model";
    roles.policy.chatPdfFallbackMethod = "page_images";
    const calls = server(roles);
    renderSection();
    for (const [label, name] of [["PDF reader deployment", "Native PDF model"], ["Page-image reader deployment", "Page image model"]]) {
      fireEvent.click(await screen.findByRole("button", { name: label }));
      fireEvent.click(within(screen.getByRole("dialog", { name: label })).getByRole("option", { name: new RegExp(name) }));
      await waitFor(() => expect(screen.getByRole("button", { name: label })).toHaveTextContent(name));
    }
    fireEvent.change(screen.getByLabelText("Fallback method"), { target: { value: "pdf_reader" } });
    await waitFor(() => expect(screen.getByLabelText("Fallback method")).toHaveValue("pdf_reader"));
    fireEvent.change(screen.getByLabelText("Processing mode"), { target: { value: "read_page_images" } });
    await waitFor(() => expect(screen.queryByLabelText("Fallback method")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "PDF reader deployment" })).toHaveTextContent("Native PDF model");
    expect(screen.getByRole("button", { name: "Page-image reader deployment" })).toHaveTextContent("Page image model");
    fireEvent.change(screen.getByLabelText("Processing mode"), { target: { value: "prefer_chat_model" } });
    await waitFor(() => expect(screen.getByLabelText("Fallback method")).toHaveValue("pdf_reader"));
    const patches = calls.filter((call) => call.method === "PATCH").map((call) => call.body);
    expect(patches).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatPdfNativeProviderModelId: "native-pdf", chatPdfNativeReasoningEffort: null }),
      expect.objectContaining({ chatPdfProviderModelId: "page-images", chatPdfReasoningEffort: null })
    ]));
    expect(patches.slice(2).every((patch) => !Object.hasOwn(patch!, "chatPdfNativeProviderModelId") && !Object.hasOwn(patch!, "chatPdfProviderModelId"))).toBe(true);
  });

  it("edits reasoning for both working roles and selects a PDF reader without a second switch", async () => {
    const roles = rolesCatalog();
    const reader = { ...luna, visionInput: "verified" as const };
    roles.documentCandidates = [reader];
    roles.verificationCandidates = [reader];
    const calls = server(roles);
    renderSection();
    const picker = await screen.findByRole("button", { name: "Page-image reader deployment" });
    expect(screen.queryByRole("switch", { name: "Send pages there" })).not.toBeInTheDocument();
    fireEvent.click(picker);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Page-image reader deployment" })).getByRole("option", { name: /GPT Luna/ }));
    await waitFor(() => expect(screen.getByTestId("admin-role-chat-pdf-status")).toHaveTextContent("Working"));
    for (const [id, label] of [["admin-role-memory", "System model reasoning"], ["admin-role-chat-pdf-images", "Page-image reader reasoning"]]) {
      fireEvent.click(within(screen.getByTestId(id!)).getByText("Advanced"));
      const reasoning = screen.getByRole("combobox", { name: label! });
      expect(reasoning).toBeEnabled();
      fireEvent.change(reasoning, { target: { value: "high" } });
      await waitFor(() => expect(reasoning).toBeEnabled());
      expect(reasoning).toHaveValue("high");
    }
    expect(patchesTo(calls, "/api/admin/providers/system-model-policy")).toEqual([
      { expectedVersion: 1, chatPdfProviderModelId: "luna", chatPdfReasoningEffort: null },
      { expectedVersion: 2, providerModelId: "luna", reasoningEffort: "high" },
      { expectedVersion: 3, chatPdfProviderModelId: "luna", chatPdfReasoningEffort: "high" }
    ]);
  });

  it("starts unconfigured Knowledge with image reading and the first eligible document model", async () => {
    const roles = rolesCatalog();
    const reader = { ...luna, visionInput: "verified" as const };
    roles.documentCandidates = [reader];
    const knowledge = knowledgeSettings();
    const calls = server(roles, { ...knowledge, profile: {
      ...knowledge.profile, activeRevision: null, availablePdfDestinations: [{
        ...documentModel, directPdf: false
      }], health: { checkedAt: null, code: "knowledge_profile_not_configured", state: "not_configured" },
      egress: { embeddingDestination: null, pdfDestination: null, representations: ["document_text_chunks", "search_queries"] }
    } });
    renderSection();
    expect(await screen.findByRole("combobox", { name: "Documents mode" })).toHaveValue("system_model_vision");
    expect(screen.getByRole("button", { name: "Documents model" })).toHaveTextContent("GPT Luna");
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    expect(patchesTo(calls, "/api/admin/knowledge")).toEqual([]);
  });

  it("exposes the MCP allowance, validates its range, preserves failed edits and saves on retry", async () => {
    const calls = server();
    renderSection();
    const tokens = await screen.findByRole("spinbutton", { name: "MCP Auto output tokens" });
    expect(tokens).toHaveValue(8192);
    expect(tokens.closest("details")).toBeNull();
    expect(screen.getByText(/hidden reasoning and JSON tool selection/)).toBeVisible();
    const save = screen.getByRole("button", { name: "Save" });
    for (const value of ["", "0", "1023", "65537", "4096.5"]) {
      fireEvent.change(tokens, { target: { value } });
      expect(save).toBeDisabled();
    }
    fireEvent.change(tokens, { target: { value: "32768" } });
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/admin/providers/model-policy" && init?.method === "PATCH"
        ? Response.json({ error: "model_policy_stale" }, { status: 409 }) : original(input, init)));
    fireEvent.click(save);
    await screen.findByRole("alert");
    expect(tokens).toHaveValue(32768);
    expect(save).toBeEnabled();
    vi.stubGlobal("fetch", original);
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText("No unsaved changes")).toBeInTheDocument());
    expect(patchesTo(calls, "/api/admin/providers/model-policy").at(-1)).toMatchObject({ mcpAutoDiscoveryMaxOutputTokens: 32768 });
    const previousGetCount = calls.filter((call) => call.method === "GET").length;
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(calls.filter((call) => call.method === "GET")).toHaveLength(previousGetCount + 3));
    expect(tokens).toHaveValue(32768);
  });

  it("saves the default chat model and tool limits with one request", async () => {
    const calls = server();
    const { reportNotice } = renderSection();
    const model = await screen.findByRole("combobox", { name: "Default chat model" });
    expect(model).toHaveValue("luna");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(model, { target: { value: "terra" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Rounds" }), { target: { value: "10" } });
    expect(screen.getByText("2 unsaved changes")).toBeInTheDocument();
    fireEvent.click(save);
    await waitFor(() => expect(reportNotice).toHaveBeenCalledWith("Chat defaults saved for new chats"));
    expect(patchesTo(calls, "/api/admin/providers/model-policy")).toEqual([{
      expectedVersion: 4, maxMcpToolsPerDiscovery: 12, maxToolCalls: 24, maxToolRounds: 10,
      mcpAutoDiscoveryTimeoutSeconds: 20, mcpAutoDiscoveryMaxOutputTokens: 8192, providerModelId: "terra", reasoningEffort: null
    }]);
    expect(screen.getByText("No unsaved changes")).toBeInTheDocument();
  });

  it("warns when no group can reach an enabled chat model and lists none", async () => {
    server();
    renderSection([]);
    expect(await screen.findByText(/No enabled chat model is reachable by any group yet/)).toBeInTheDocument();
    const model = screen.getByRole("combobox", { name: "Default chat model" });
    expect(within(model).getByRole("option", { name: /Unavailable — OpenAI \/ GPT Luna/ })).toBeDisabled();
    expect(within(model).queryByRole("option", { name: "OpenAI / GPT Terra" })).not.toBeInTheDocument();
  });

  it("keeps Knowledge processing behind Apply plus the reindexing confirmation", async () => {
    const calls = server();
    const { requestConfirmation } = renderSection();
    const embeddings = await screen.findByRole("button", { name: "Embeddings model" });
    expect(embeddings).toHaveTextContent("Local embeddings / Multilingual embed · 1024d");
    expect(screen.getByTestId("admin-knowledge-state")).toHaveTextContent("Ready");
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    fireEvent.click(embeddings);
    fireEvent.click(screen.getByRole("option", { name: /Qwen3 Embedding 8B · 1536d/ }));
    expect(patchesTo(calls, "/api/admin/knowledge")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    const config = requestConfirmation.mock.calls[0]![0];
    expect(config.title).toBe("Reprocess all Knowledge documents?");
    expect(config.body).toContain("Existing indexes stay online until their replacements are ready");
    expect(config.body).toContain("authorizes the disclosed processing, external requests, and reindexing");
    await config.onConfirm();
    await waitFor(() => expect(screen.getByTestId("admin-knowledge-state")).toHaveTextContent("Reindexing 1 of 5 bases"));
    expect(patchesTo(calls, "/api/admin/knowledge")).toEqual([{
      action: "activate_profile", deploymentId: "qwen", documentDeploymentId: null, documentReasoningEffort: null, expectedVersion: 1, pdfProcessingMode: "local"
    }]);
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  });

  it("restores an earlier configuration from the sheet after the same confirmation", async () => {
    const calls = server();
    const { requestConfirmation } = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Knowledge processing actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Earlier configurations" }));
    const sheet = await screen.findByRole("dialog", { name: "Earlier configurations" });
    expect(within(sheet).getByText(/Embeddings: OpenRouter \/ Qwen3 Embedding 8B · 1536d · Documents: Local · no model/)).toBeInTheDocument();
    expect(within(sheet).queryByText(/revision/i)).not.toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: /^Restore configuration applied/ }));
    const config = requestConfirmation.mock.calls[0]![0];
    expect(config.title).toBe("Restore this configuration?");
    await config.onConfirm();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Earlier configurations" })).not.toBeInTheDocument());
    expect(patchesTo(calls, "/api/admin/knowledge")).toEqual([{ action: "rollback_profile", expectedVersion: 1, revisionId: "profile-revision-0" }]);
  });

  it("keeps Documents reasoning independent and requires confirmation for a reasoning-only change", async () => {
    const calls = server(rolesCatalog(), documentSettings());
    const { requestConfirmation } = renderSection();
    const documents = await screen.findByTestId("admin-role-documents");
    fireEvent.click(within(documents).getByText("Advanced"));
    const reasoning = screen.getByRole("combobox", { name: "Documents reasoning" });
    expect(reasoning).toHaveValue("");
    expect(within(reasoning).getByRole("option", { name: "Reasoning: Default (medium)" })).toHaveValue("");
    expect(within(reasoning).getByRole("option", { name: "Reasoning: none" })).toHaveValue("none");
    fireEvent.change(reasoning, { target: { value: "none" } });
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(patchesTo(calls, "/api/admin/knowledge")).toEqual([]);
    // Cancelling the confirmation leaves the same draft and active revision.
    fireEvent.click(within(screen.getByTestId("admin-role-knowledge")).getByRole("button", { name: "Discard" }));
    expect(reasoning).toHaveValue("");
    fireEvent.change(reasoning, { target: { value: "low" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await act(async () => requestConfirmation.mock.calls.at(-1)![0].onConfirm());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument());
    expect(patchesTo(calls, "/api/admin/knowledge")).toEqual([{
      action: "activate_profile", deploymentId: "embedding-model-1", documentDeploymentId: "luna",
      documentReasoningEffort: "low", expectedVersion: 1, pdfProcessingMode: "system_model_vision"
    }]);
    const reads = calls.length;
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(calls.length).toBeGreaterThan(reads));
    expect(reasoning).toHaveValue("low");
    expect(patchesTo(calls, "/api/admin/providers/system-model-policy")).toEqual([]);
  });

  it("resets Documents reasoning on model or mode changes and restores it on Discard", async () => {
    const calls = server(rolesCatalog(), documentSettings("high"));
    renderSection();
    fireEvent.click(within(await screen.findByTestId("admin-role-documents")).getByText("Advanced"));
    const reasoning = screen.getByRole("combobox", { name: "Documents reasoning" });
    expect(reasoning).toHaveValue("high");
    fireEvent.click(screen.getByRole("button", { name: "Documents model" }));
    fireEvent.click(within(screen.getByRole("listbox", { name: "Ready for Documents" })).getByRole("option", { name: /GPT Terra/ }));
    expect(reasoning).toHaveValue("");
    expect(reasoning).toBeDisabled();
    expect(within(reasoning).getAllByRole("option")).toHaveLength(1);
    fireEvent.click(within(screen.getByTestId("admin-role-knowledge")).getByRole("button", { name: "Discard" }));
    expect(reasoning).toHaveValue("high");
    fireEvent.change(screen.getByRole("combobox", { name: "Documents mode" }), { target: { value: "system_model_direct_pdf" } });
    expect(reasoning).toHaveValue("");
    fireEvent.click(within(screen.getByTestId("admin-role-knowledge")).getByRole("button", { name: "Discard" }));
    expect(reasoning).toHaveValue("high");
    fireEvent.change(screen.getByRole("combobox", { name: "Documents mode" }), { target: { value: "local" } });
    expect(screen.queryByRole("combobox", { name: "Documents reasoning" })).not.toBeInTheDocument();
    expect(patchesTo(calls, "/api/admin/knowledge")).toEqual([]);
  });

  it("shows unavailable saved reasoning honestly and preserves a failed draft across stale refresh", async () => {
    const calls = server(rolesCatalog(), documentSettings("removed-level"));
    const { reportError, requestConfirmation } = renderSection();
    fireEvent.click(within(await screen.findByTestId("admin-role-documents")).getByText("Advanced"));
    const reasoning = screen.getByRole("combobox", { name: "Documents reasoning" });
    expect(within(reasoning).getByRole("option", { name: "Reasoning: removed-level (unavailable)" })).toBeDisabled();
    fireEvent.change(reasoning, { target: { value: "low" } });
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "/api/admin/knowledge" && init?.method === "PATCH"
        ? Response.json({ error: "knowledge_profile_stale" }, { status: 409 }) : original(input, init)));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await act(async () => requestConfirmation.mock.calls.at(-1)![0].onConfirm());
    await waitFor(() => expect(reportError).toHaveBeenCalledWith(expect.stringMatching(/changed elsewhere/)));
    expect(reasoning).toHaveValue("low");
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    expect(patchesTo(calls, "/api/admin/knowledge")).toEqual([]);
    fireEvent.click(within(screen.getByTestId("admin-role-knowledge")).getByRole("button", { name: "Discard" }));
    expect(reasoning).toHaveValue("removed-level");
  });

  it("reports a stale immediate apply and reloads the current assignment instead of guessing", async () => {
    const calls = server();
    const { reportError } = renderSection();
    const trigger = await screen.findByRole("button", { name: "System model deployment" });
    // Another session moved the policy on: the picker's optimistic version is behind.
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return Response.json({ error: "system_model_policy_stale" }, { status: 409 });
      return original(input, init);
    }));
    fireEvent.click(screen.getByRole("button", { name: "System model actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear assignment" }));
    await waitFor(() => expect(reportError).toHaveBeenCalledWith(expect.stringMatching(/changed elsewhere/)));
    expect(trigger).toHaveTextContent("OpenAI / GPT Luna");
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });
});

it("saves, changes reasoning, clears and undoes Chat titles independently", async () => {
  const calls = server();
  const { reportNotice } = renderSection();
  const picker = await screen.findByRole("button", { name: "Chat titles deployment" });
  expect(screen.getByTestId("admin-role-chat-titles-status")).toHaveTextContent("Not assigned");
  fireEvent.click(picker);
  fireEvent.click(screen.getByRole("option", { name: /Small title model/ }));
  await waitFor(() => expect(picker).toHaveTextContent("Small title model"));
  fireEvent.click(within(screen.getByTestId("admin-role-chat-titles")).getByText("Advanced"));
  const reasoning = screen.getByRole("combobox", { name: "Chat titles reasoning" });
  expect(reasoning).toHaveValue("none");
  fireEvent.change(reasoning, { target: { value: "low" } });
  await waitFor(() => expect(reasoning).toHaveValue("low"));
  await waitFor(() => expect(reasoning).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Chat titles actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Clear assignment" }));
  await waitFor(() => expect(screen.getByTestId("admin-role-chat-titles-status")).toHaveTextContent("Not assigned"));
  reportNotice.mock.calls.at(-1)![1]!.onSelect();
  await waitFor(() => expect(picker).toHaveTextContent("Small title model"));
  expect(reasoning).toHaveValue("low");
  expect(screen.getByRole("button", { name: "System model deployment" })).toHaveTextContent("GPT Luna");
  expect(patchesTo(calls, "/api/admin/providers/system-model-policy")).toEqual([
    { expectedVersion: 1, chatTitleProviderModelId: "title-model", chatTitleReasoningEffort: "none" },
    { expectedVersion: 2, chatTitleProviderModelId: "title-model", chatTitleReasoningEffort: "low" },
    { expectedVersion: 3, chatTitleProviderModelId: null, chatTitleReasoningEffort: null },
    { expectedVersion: 4, chatTitleProviderModelId: "title-model", chatTitleReasoningEffort: "low" }
  ]);
});
