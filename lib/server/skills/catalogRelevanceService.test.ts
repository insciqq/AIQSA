import { describe, expect, it, vi } from "vitest";
import { jevModelConfiguration, JEV_SERVED_MODEL_ID } from "../../domain/decisionModels";
import type { DecisionModelRoleResolution } from "../providerRuntime/decisionModelRole";
import type { OptionalDecisionExecutor } from "../providerRuntime/optionalDecision";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { createSkillCatalogRelevanceService, SkillCatalogAuthorityChangedError } from "./catalogRelevanceService";

const candidates = Array.from({ length: 33 }, (_, index) => ({ skillId: `skill-${index}`, revisionId: `revision-${index}`,
  name: `Procedure ${index}`, description: `Use for task ${index}.` }));
const cohort = () => Object.fromEntries(candidates.map((_skill, index) => [`s${index}`, { type: "noul" as const, noul: index === 2 ? 1 : 0 }]));

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
  const decide = vi.fn<OptionalDecisionExecutor>(async request => { await request.authorize(); return cohort(); });
  const authorize = vi.fn(async () => undefined);
  const input = { userId: "owner", operationKey: "bounded-admission-key", query: "Help with task 2.", candidates, authorize };
  return { resolve, decide, authorize, input, service: createSkillCatalogRelevanceService({ resolve, decide }) };
}

describe("optional catalog relevance service", () => {
  it("rechecks authority around a single bounded optional operation and returns only offered identities", async () => {
    const f = setup();
    expect(await f.service(f.input)).toEqual(["skill-2"]);
    expect(f.decide).toHaveBeenCalledOnce();
    expect(f.authorize).toHaveBeenCalledTimes(3);
    expect(f.decide.mock.calls[0]![0]).toMatchObject({ owner: { userId: "owner", purpose: "skill_catalog_relevance", operationKey: f.input.operationKey } });
    const payload = JSON.stringify(f.decide.mock.calls[0]![0].request);
    expect(payload).not.toContain("skill-2"); expect(payload).not.toContain("revision-2");
    expect(candidates).toHaveLength(33);
  });
  it("does no optional dispatch or authority work while disabled and skips small catalogs before resolving a role", async () => {
    const f = setup();
    expect(await f.service({ ...f.input, candidates: candidates.slice(0, 32) })).toBeNull();
    expect(f.resolve).not.toHaveBeenCalled();
    f.resolve.mockResolvedValue({ ok: false, code: "decision_feature_disabled", selectedProviderModelId: "model" });
    expect(await f.service(f.input)).toBeNull();
    expect(f.decide).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
  });
  it("retains the original catalog on provider, role, absent or incomplete evidence", async () => {
    const f = setup();
    f.resolve.mockRejectedValueOnce(new Error("role_unavailable"));
    expect(await f.service(f.input)).toBeNull();
    f.decide.mockRejectedValueOnce(new Error("provider_unavailable"));
    expect(await f.service(f.input)).toBeNull();
    f.decide.mockResolvedValueOnce(null);
    expect(await f.service(f.input)).toBeNull();
    f.decide.mockResolvedValueOnce({ s2: { type: "noul", noul: 1 } });
    expect(await f.service(f.input)).toBeNull();
  });
  it("binds replay evidence to exact revisions without disclosing revision identifiers", async () => {
    const f = setup(); await f.service(f.input);
    await f.service({ ...f.input, candidates: candidates.map(skill => ({ ...skill, revisionId: `${skill.revisionId}-new` })) });
    expect(f.decide.mock.calls[0]![0].policy).not.toBe(f.decide.mock.calls[1]![0].policy);
    expect(f.decide.mock.calls[0]![0].request).toEqual(f.decide.mock.calls[1]![0].request);
  });
  it("never relabels owner or catalog revocation as a provider fallback, even if an executor swallows it", async () => {
    const f = setup();
    f.authorize.mockRejectedValueOnce(new SkillCatalogAuthorityChangedError());
    await expect(f.service(f.input)).rejects.toThrow("skill_catalog_authority_changed");
    expect(f.decide).not.toHaveBeenCalled();
    f.decide.mockImplementation(async request => {
      f.authorize.mockRejectedValueOnce(new SkillCatalogAuthorityChangedError());
      await request.authorize().catch(() => undefined);
      return cohort();
    });
    await expect(f.service(f.input)).rejects.toThrow("skill_catalog_authority_changed");
  });
  it("rejects a late successful response after scope revocation or cancellation", async () => {
    const f = setup();
    f.decide.mockImplementation(async () => {
      f.authorize.mockRejectedValueOnce(new SkillCatalogAuthorityChangedError());
      return cohort();
    });
    await expect(f.service(f.input)).rejects.toThrow("skill_catalog_authority_changed");
    const controller = new AbortController();
    f.decide.mockImplementation(async () => { controller.abort(new Error("cancelled")); return cohort(); });
    await expect(f.service({ ...f.input, signal: controller.signal })).rejects.toThrow("cancelled");
  });
  it("preserves cancellation that arrives during the final asynchronous authority check", async () => {
    const f = setup(); const controller = new AbortController(); let checks = 0;
    f.authorize.mockImplementation(async () => {
      if (++checks === 3) controller.abort(new Error("cancelled_during_recheck"));
    });
    await expect(f.service({ ...f.input, signal: controller.signal })).rejects.toThrow("cancelled_during_recheck");
    expect(f.decide).toHaveBeenCalledOnce();
  });
});
