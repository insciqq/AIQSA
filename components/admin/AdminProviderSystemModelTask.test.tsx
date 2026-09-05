import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminKnowledgeSettingsFixture } from "@/tests/support/knowledgeProfile";
import type { AdminSystemModelPolicyCatalog } from "@/lib/contracts/adminSystemModelPolicy";
import { AdminProviderSystemModelTask } from "./AdminProviderSystemModelTask";

const memory = {
  connectionDisplayName: "Semantic provider", connectionId: "semantic", defaultReasoningEffort: "medium",
  displayName: "Strict model", forcedToolCall: "verified" as const, id: "memory-model",
  reasoningEfforts: ["low", "medium"], structuredOutput: "verified" as const, visionInput: "not_verified" as const
};
const vision = { ...memory, connectionId: "documents", connectionDisplayName: "Documents provider",
  displayName: "Vision model", id: "vision-model", forcedToolCall: "unsupported" as const,
  structuredOutput: "unsupported" as const, visionInput: "verified" as const };
const reranker = { connectionId: "ranking", connectionDisplayName: "Ranking provider", displayName: "Reranker", id: "rank-model" };
function catalog(): AdminSystemModelPolicyCatalog {
  return { candidates: [memory], documentCandidates: [vision], verificationCandidates: [memory, vision],
    rerankerCandidates: [reranker], policy: { chatPdfModel: null, chatPdfReasoningEffort: null,
      chatPdfPreparationAllowed: false, reasoningEffort: null, rerankerModel: null, systemModel: null,
      updatedAt: "2026-09-05T00:00:00.000Z", updatedBy: null, version: 1 } };
}
function server(initial = catalog(), failSave = false) {
  let value = initial;
  const requests: { method: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    if (url === "/api/admin/knowledge") return Response.json({ knowledge: adminKnowledgeSettingsFixture() });
    if (init?.method === "PATCH" || init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      requests.push({ method: init.method, body });
      if (failSave) return Response.json({ error: "system_model_policy_stale" }, { status: 409 });
      if (init.method === "PATCH") value = { ...value, policy: { ...value.policy, version: value.policy.version + 1,
        ...(Object.hasOwn(body, "providerModelId") ? { systemModel: body.providerModelId ? { ...memory, available: true } : null, reasoningEffort: body.reasoningEffort } : {}),
        ...(Object.hasOwn(body, "rerankerProviderModelId") ? { rerankerModel: body.rerankerProviderModelId ? { ...reranker, available: true } : null } : {}),
        ...(Object.hasOwn(body, "chatPdfProviderModelId") ? { chatPdfModel: body.chatPdfProviderModelId ? { ...vision, available: true } : null,
          chatPdfReasoningEffort: body.chatPdfReasoningEffort, chatPdfPreparationAllowed: body.chatPdfPreparationAllowed } : {})
      } };
    }
    return Response.json({ systemModelPolicy: value });
  }));
  return requests;
}
afterEach(() => vi.unstubAllGlobals());

describe("System Models assignments", () => {
  it("separates verified Memory, Vision and dedicated reranker choices", async () => {
    server();
    render(<AdminProviderSystemModelTask active />);
    const memorySelect = await screen.findByRole("combobox", { name: "Memory semantic model" });
    expect(within(memorySelect).getByRole("option", { name: /Strict model/ })).toBeInTheDocument();
    expect(within(memorySelect).queryByRole("option", { name: /Vision model|Reranker/ })).not.toBeInTheDocument();
    const pdfSelect = screen.getByRole("combobox", { name: "Chat PDF model" });
    expect(within(pdfSelect).getByRole("option", { name: /Vision model/ })).toBeInTheDocument();
    expect(within(pdfSelect).queryByRole("option", { name: /Strict model/ })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Allow chat PDF preparation/ })).not.toBeChecked();
    expect(screen.getByText(/Requires verified strict Structured Output/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Memory role" })).toBeDisabled();
  });

  it("saves one role and retains a dirty PDF choice without sending it", async () => {
    const requests = server();
    render(<AdminProviderSystemModelTask active />);
    fireEvent.change(await screen.findByLabelText("Memory semantic model"), { target: { value: memory.id } });
    fireEvent.change(screen.getByLabelText("Chat PDF model"), { target: { value: vision.id } });
    fireEvent.click(screen.getByLabelText("Allow chat PDF preparation at this destination"));
    fireEvent.click(screen.getByRole("button", { name: "Save Memory role" }));
    await screen.findByText("Assignment saved for future work.");
    expect(requests).toEqual([{ method: "PATCH", body: { expectedVersion: 1, providerModelId: memory.id, reasoningEffort: null } }]);
    expect(screen.getByLabelText("Chat PDF model")).toHaveValue(vision.id);
    expect(screen.getByLabelText("Allow chat PDF preparation at this destination")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save chat PDF role" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.body).toEqual({ expectedVersion: 2, chatPdfProviderModelId: vision.id,
      chatPdfReasoningEffort: null, chatPdfPreparationAllowed: true });
  });

  it("shows a removed assignment truthfully and clears only that role", async () => {
    const value = catalog();
    value.candidates = [];
    value.policy.systemModel = { ...memory, available: false };
    value.policy.rerankerModel = { ...reranker, available: true };
    const requests = server(value);
    render(<AdminProviderSystemModelTask active />);
    const selector = await screen.findByLabelText("Memory semantic model");
    expect(within(selector).getByRole("option", { name: /Unavailable/ })).toBeDisabled();
    fireEvent.change(selector, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Memory role" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.body).toEqual({ expectedVersion: 1, providerModelId: null, reasoningEffort: null });
    expect(screen.getByLabelText("Reranking model")).toHaveValue(reranker.id);
  });

  it("retains drafts on stale save and explains refresh", async () => {
    server(catalog(), true);
    render(<AdminProviderSystemModelTask active />);
    fireEvent.change(await screen.findByLabelText("Memory semantic model"), { target: { value: memory.id } });
    fireEvent.click(screen.getByRole("button", { name: "Save Memory role" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reload and apply your choice again");
    expect(screen.getByLabelText("Memory semantic model")).toHaveValue(memory.id);
  });

  it("verifies an explicit role without assigning the candidate", async () => {
    const requests = server();
    render(<AdminProviderSystemModelTask active />);
    fireEvent.click(await screen.findByText("Verify a deployment for a role"));
    fireEvent.change(screen.getByLabelText("Role to verify"), { target: { value: "vision" } });
    fireEvent.change(screen.getByLabelText("Deployment to verify"), { target: { value: vision.id } });
    fireEvent.click(screen.getByRole("button", { name: "Verify selected role (paid request)" }));
    await screen.findByText("Selected role verified. Assignments and other drafts are unchanged.");
    expect(requests).toEqual([{ method: "POST", body: { providerModelId: vision.id, role: "vision" } }]);
    expect(screen.getByLabelText("Chat PDF model")).toHaveValue("");
  });

  it("offers an explicit retry after a failed initial load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })));
    render(<AdminProviderSystemModelTask active />);
    await screen.findByText("System Models is unavailable. Refresh to retry.");
    expect(screen.getByRole("button", { name: "Refresh roles" })).toBeEnabled();
  });
});
