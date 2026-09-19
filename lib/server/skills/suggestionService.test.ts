import { describe, expect, it, vi } from "vitest";
import { jevModelConfiguration, JEV_SERVED_MODEL_ID } from "../../domain/decisionModels";
import type { SkillSuggestionRequest } from "../../contracts/skillSuggestions";
import type { DecisionModelRoleResolution } from "../providerRuntime/decisionModelRole";
import type { OptionalDecisionExecutor } from "../providerRuntime/optionalDecision";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { createSkillSuggestionService } from "./suggestionService";

const input: SkillSuggestionRequest = { requestId: "00000000-0000-4000-8000-000000000001", draft: "Help with this task",
  chatId: null, projectId: null, expectedActiveLeafMessageId: null, excludedIds: [] };
const candidate = { id: "skill", revisionId: "revision", name: "Procedure", description: "Procedure description" };
function setup() {
  const model = jevModelConfiguration();
  const authority = { connectionId: "connection", connectionVersion: 1, credentialId: "credential", credentialVersionId: "version",
    providerModelId: "model", modelVersion: 1 };
  const snapshot: ProviderExecutionSnapshot = { version: 1, ...authority, providerFamily: "openrouter",
    connectionDisplayName: "Provider", modelDisplayName: "Decision model", model,
    connection: { apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer", allowPrivateNetwork: false, responseTimeoutMs: 30_000 },
    decisionVerification: { probeVersion: 1, adapterKind: "openrouter_decisions", upstreamModelId: model.upstreamModelId,
      servedModelId: JEV_SERVED_MODEL_ID, provider: "TypeSafe", noul: true, choice: true } };
  const resolution: DecisionModelRoleResolution = { ok: true, credentialScope: "installation", policyVersion: 1, providerModelId: "model",
    role: { authority, snapshot, configuration: model, credentialSource: "default", provider: "openrouter" } };
  const resolve = vi.fn(async (): Promise<DecisionModelRoleResolution> => resolution);
  const load = vi.fn(async () => ({ candidates: [candidate], context: [] }));
  const decide = vi.fn<OptionalDecisionExecutor>(async request => { await request.authorize(); return { s0: { type: "noul", noul: 1 } }; });
  const authorizeSession = vi.fn(async () => undefined);
  return { resolve, load, decide, authorizeSession, options: { signal: new AbortController().signal, authorizeSession },
    service: createSkillSuggestionService({ resolve, load, decide }) };
}
describe("optional Skill suggestion service", () => {
  it("suggests authorized metadata without attaching instructions and rechecks before and after I/O", async () => {
    const f = setup();
    expect(await f.service("user", input, f.options)).toEqual({ status: "ready", skills: [{ id: "skill", name: candidate.name, description: candidate.description }] });
    expect(f.load).toHaveBeenCalledTimes(3);
    expect(f.decide.mock.calls[0]![0]).toMatchObject({ owner: { userId: "user", purpose: "skill_suggestions", operationKey: input.requestId } });
    expect(JSON.stringify(f.decide.mock.calls[0]![0].request)).not.toContain("revision");
  });
  it("skips paid work for disabled/absent deployments, empty drafts and excluded catalogs", async () => {
    const f = setup();
    expect(await f.service("user", { ...input, draft: " " }, f.options)).toEqual({ status: "ready", skills: [] });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(await f.service("user", { ...input, excludedIds: [candidate.id] }, f.options)).toEqual({ status: "ready", skills: [] });
    f.resolve.mockResolvedValue({ ok: false, code: "decision_feature_disabled", selectedProviderModelId: "model" });
    expect(await f.service("user", input, f.options)).toEqual({ status: "disabled", skills: [] });
    expect(f.decide).not.toHaveBeenCalled();
  });
  it("discards suggestions when a revision or grant changes during the call", async () => {
    const f = setup();
    f.decide.mockImplementation(async request => { await request.authorize();
      f.load.mockResolvedValue({ candidates: [], context: [] }); return { s0: { type: "noul", noul: 1 } }; });
    expect(await f.service("user", input, f.options)).toEqual({ status: "unavailable", skills: [] });
  });
  it("does not let an outage, invalid cohort or expired session grant a recommendation", async () => {
    const f = setup();
    f.decide.mockRejectedValueOnce(new Error("network"));
    expect(await f.service("user", input, f.options)).toEqual({ status: "unavailable", skills: [] });
    f.decide.mockResolvedValueOnce({ unoffered: { type: "noul", noul: 1 } });
    expect(await f.service("user", input, f.options)).toEqual({ status: "unavailable", skills: [] });
    f.authorizeSession.mockRejectedValueOnce(new Error("session_revoked"));
    expect(await f.service("user", input, f.options)).toEqual({ status: "unavailable", skills: [] });
    expect(f.decide).toHaveBeenCalledTimes(2);
  });
  it("binds replay identity to exact revisions and scope even when public descriptions are equal", async () => {
    const f = setup(); await f.service("user", input, f.options);
    f.load.mockResolvedValue({ candidates: [{ ...candidate, revisionId: "revision-new" }], context: [] });
    await f.service("user", input, f.options);
    expect(f.decide.mock.calls[0]![0].policy).not.toBe(f.decide.mock.calls[1]![0].policy);
  });
  it("honors cancellation without applying a late response", async () => {
    const f = setup(); const controller = new AbortController();
    f.decide.mockImplementation(async () => { controller.abort(new Error("cancelled")); return { s0: { type: "noul", noul: 1 } }; });
    await expect(f.service("user", input, { ...f.options, signal: controller.signal })).rejects.toThrow("cancelled");
  });
});
