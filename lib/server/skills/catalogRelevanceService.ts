import type { PrismaClient } from "@prisma/client";
import { createDecisionModelRoleResolver, type DecisionModelRoleResolution } from "../providerRuntime/decisionModelRole";
import { createPrismaOptionalDecisionService, type OptionalDecisionExecutor } from "../providerRuntime/optionalDecision";
import { optionalDecisionInputHash } from "../providerRuntime/optionalDecisionRepository";
import { buildSkillCatalogRelevancePlan, skillCatalogRelevanceSelection, SKILL_CATALOG_RELEVANCE_POLICY } from "./catalogRelevancePolicy";
import type { SkillRunCatalogEntry } from "./runMaterialization";

export class SkillCatalogAuthorityChangedError extends Error {
  constructor() { super("skill_catalog_authority_changed"); }
}

export type SkillCatalogRelevanceService = (input: Readonly<{
  userId: string;
  operationKey: string;
  query: string;
  candidates: readonly SkillRunCatalogEntry[];
  signal?: AbortSignal;
  /** Recheck the current request owner, scope and complete candidate identity.
   * Authority failure is not an optional relevance-provider failure. */
  authorize(): Promise<void>;
}>) => Promise<readonly string[] | null>;

export function createSkillCatalogRelevanceService(deps: Readonly<{
  resolve(): Promise<DecisionModelRoleResolution>;
  decide: OptionalDecisionExecutor;
}>): SkillCatalogRelevanceService {
  return async input => {
    input.signal?.throwIfAborted();
    const plan = buildSkillCatalogRelevancePlan(input);
    if (!plan || !input.operationKey || input.operationKey.length > 128 || /[\u0000-\u0020\u007f]/u.test(input.operationKey)) return null;
    let resolution: DecisionModelRoleResolution;
    try { resolution = await deps.resolve(); }
    catch { input.signal?.throwIfAborted(); return null; }
    input.signal?.throwIfAborted();
    if (!resolution.ok) return null;
    await input.authorize();
    input.signal?.throwIfAborted();
    let authorizationFailure: unknown;
    let authorizationFailed = false;
    const authorize = async () => {
      input.signal?.throwIfAborted();
      try { await input.authorize(); input.signal?.throwIfAborted(); }
      catch (error) { authorizationFailure = error; authorizationFailed = true; throw error; }
    };
    // This private hash binds stable cohort identities without disclosing them
    // in the decision request or storing metadata solely for diagnostics.
    const cohort = optionalDecisionInputHash(input.candidates.map(({ skillId, revisionId }) => ({ skillId, revisionId })));
    let answers: Awaited<ReturnType<OptionalDecisionExecutor>>;
    try {
      answers = await deps.decide({
        owner: { userId: input.userId, purpose: "skill_catalog_relevance", operationKey: input.operationKey },
        evidence: { ...resolution.role.authority, executionSnapshot: resolution.role.snapshot },
        policy: `${SKILL_CATALOG_RELEVANCE_POLICY}:${cohort}`, request: plan.request,
        authorize, signal: input.signal
      });
    } catch (error) {
      input.signal?.throwIfAborted();
      if (authorizationFailed) throw authorizationFailure;
      if (error instanceof SkillCatalogAuthorityChangedError) throw error;
      await input.authorize();
      input.signal?.throwIfAborted();
      return null;
    }
    input.signal?.throwIfAborted();
    if (authorizationFailed) throw authorizationFailure;
    await input.authorize();
    input.signal?.throwIfAborted();
    return skillCatalogRelevanceSelection(plan, answers);
  };
}

export function createPrismaSkillCatalogRelevanceService(db: PrismaClient): SkillCatalogRelevanceService {
  const roles = createDecisionModelRoleResolver(db);
  return createSkillCatalogRelevanceService({
    resolve: () => roles.resolve("skillCatalogRelevance"), decide: createPrismaOptionalDecisionService(db)
  });
}
