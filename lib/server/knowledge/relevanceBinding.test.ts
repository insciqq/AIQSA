import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { jevModelConfiguration, JEV_SERVED_MODEL_ID } from "../../domain/decisionModels";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { insertAcceptedKnowledgeRelevanceBinding, loadAcceptedKnowledgeRelevanceRole } from "./relevanceBinding";

const { resolve } = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../providerRuntime/decisionModelRole", () => ({
  createDecisionModelRoleResolver: () => ({ resolve })
}));

function fixture() {
  const snapshot: ProviderExecutionSnapshot = {
    version: 1, connectionId: "connection", credentialId: "credential", credentialVersionId: "key-version",
    connectionDisplayName: "Provider", modelDisplayName: "Decision", providerModelId: "model", providerFamily: "openrouter",
    connection: { apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer", allowPrivateNetwork: false, responseTimeoutMs: 30_000 },
    model: jevModelConfiguration(), decisionVerification: { probeVersion: 1, adapterKind: "openrouter_decisions",
      upstreamModelId: "typesafe/jev-1.13", servedModelId: JEV_SERVED_MODEL_ID, provider: "TypeSafe", noul: true, choice: true }
  };
  const authority = { connectionId: "connection", providerModelId: "model", credentialId: "credential", credentialVersionId: "key-version" };
  const role = { snapshot, authority: { ...authority, connectionVersion: 2, modelVersion: 3 } };
  const create = vi.fn(async () => ({}));
  const findFirst = vi.fn(async () => ({ ...authority, role: "decision", credentialSource: "default", executionSnapshot: snapshot }));
  const db = { providerRunBinding: { create, findFirst } } as unknown as Prisma.TransactionClient;
  resolve.mockReset(); resolve.mockResolvedValue({ ok: true, role });
  return { db, create, findFirst, snapshot, authority, role };
}

describe("accepted Knowledge Decisions binding", () => {
  it("freezes the qualified role with retained credential authority and never rereads current settings", async () => {
    const f = fixture();
    await insertAcceptedKnowledgeRelevanceBinding(f.db, "run");
    expect(f.create).toHaveBeenCalledWith({ data: {
      ...f.authority, modelRunId: "run", bindingKey: "knowledge_relevance_v1", role: "decision",
      credentialSource: "default", executionSnapshot: f.snapshot
    } });
    resolve.mockResolvedValue({ ok: false, code: "decision_feature_disabled" });
    expect(await loadAcceptedKnowledgeRelevanceRole(f.db, { runId: "run", userId: "owner" }))
      .toEqual({ ok: true, role: { authority: f.authority, snapshot: f.snapshot } });
    expect(resolve).toHaveBeenCalledExactlyOnceWith("knowledgeRelevance");
    expect(f.findFirst).toHaveBeenCalledWith({ where: {
      modelRunId: "run", modelRun: { userId: "owner" }, bindingKey: "knowledge_relevance_v1", role: "decision"
    } });
  });

  it.each(["decision_model_absent", "decision_feature_disabled", "decision_model_unavailable"])(
    "keeps %s frozen off even if the role is assigned later", async code => {
      const f = fixture(); resolve.mockResolvedValue({ ok: false, code });
      await insertAcceptedKnowledgeRelevanceBinding(f.db, "run");
      expect(f.create).not.toHaveBeenCalled();
      resolve.mockResolvedValue({ ok: true, role: f.role }); f.findFirst.mockResolvedValue(null as never);
      expect(await loadAcceptedKnowledgeRelevanceRole(f.db, { runId: "run", userId: "owner" }))
        .toEqual({ ok: false, code: "decision_model_absent" });
      expect(resolve).toHaveBeenCalledTimes(1);
    }
  );

  it("does not admit an unqualified served revision", async () => {
    const f = fixture();
    resolve.mockResolvedValue({ ok: true, role: { ...f.role, snapshot: {
      ...f.snapshot, decisionVerification: { ...f.snapshot.decisionVerification!, servedModelId: "unqualified-revision" }
    } } });
    await insertAcceptedKnowledgeRelevanceBinding(f.db, "run");
    expect(f.create).not.toHaveBeenCalled();
  });

  it("rejects a persisted snapshot swapped to another key", async () => {
    const f = fixture();
    f.findFirst.mockResolvedValue({ ...f.authority, credentialVersionId: "different-key", role: "decision",
      credentialSource: "default", executionSnapshot: f.snapshot });
    await expect(loadAcceptedKnowledgeRelevanceRole(f.db, { runId: "run", userId: "owner" }))
      .rejects.toThrow("knowledge_relevance_binding_invalid");
  });
});
