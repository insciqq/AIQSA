import type { PrismaClient } from "@prisma/client";
import type { SkillSuggestionRequest, SkillSuggestionResponse } from "../../contracts/skillSuggestions";
import { createDecisionModelRoleResolver, type DecisionModelRoleResolution } from "../providerRuntime/decisionModelRole";
import { createPrismaOptionalDecisionService, type OptionalDecisionExecutor } from "../providerRuntime/optionalDecision";
import { optionalDecisionInputHash } from "../providerRuntime/optionalDecisionRepository";
import { buildSkillSuggestionPlan, selectedSkillSuggestions, SKILL_SUGGESTION_POLICY_VERSION } from "./suggestionPolicy";
import { createSkillSuggestionContextLoader, type SkillSuggestionContextLoader } from "./suggestionRepository";

export type SkillSuggestionService = (userId: string, input: SkillSuggestionRequest,
  options: Readonly<{ signal: AbortSignal; authorizeSession(): Promise<void> }>
) => Promise<SkillSuggestionResponse>;

export function createSkillSuggestionService(deps: Readonly<{
  load: SkillSuggestionContextLoader;
  resolve(): Promise<DecisionModelRoleResolution>;
  decide: OptionalDecisionExecutor;
}>): SkillSuggestionService {
  return async (userId, input, options) => {
    try {
      options.signal.throwIfAborted();
      await options.authorizeSession();
      if (!input.draft.trim()) return { status: "ready", skills: [] };
      const resolution = await deps.resolve();
      if (!resolution.ok) return { status: resolution.code === "decision_model_unavailable" ? "unavailable" : "disabled", skills: [] };
      const materialized = await deps.load(userId, input);
      if (!materialized) return { status: "unavailable", skills: [] };
      const plan = buildSkillSuggestionPlan({ ...materialized, draft: input.draft, excludedIds: new Set(input.excludedIds) });
      if (!plan) return { status: "ready", skills: [] };
      const identity = optionalDecisionInputHash(materialized);
      const scope = optionalDecisionInputHash({ chatId: input.chatId, projectId: input.projectId,
        leaf: input.expectedActiveLeafMessageId, identity });
      const authorize = async () => {
        await options.authorizeSession();
        const current = await deps.load(userId, input);
        if (!current || optionalDecisionInputHash(current) !== identity) throw new Error("skill_suggestion_authority_changed");
      };
      const answers = await deps.decide({ owner: { userId, purpose: "skill_suggestions", operationKey: input.requestId },
        evidence: { ...resolution.role.authority, executionSnapshot: resolution.role.snapshot },
        policy: `${SKILL_SUGGESTION_POLICY_VERSION}:${scope}`, request: plan.request, authorize, signal: options.signal });
      await authorize();
      options.signal.throwIfAborted();
      const selected = answers ? selectedSkillSuggestions(plan, answers) : null;
      return selected ? { status: "ready", skills: selected.map(({ id, name, description }) => ({ id, name, description })) }
        : { status: "unavailable", skills: [] };
    } catch {
      options.signal.throwIfAborted();
      // Suggestions never gate manual selection or sending a message.
      return { status: "unavailable", skills: [] };
    }
  };
}

export function createPrismaSkillSuggestionService(db: PrismaClient): SkillSuggestionService {
  const roles = createDecisionModelRoleResolver(db);
  return createSkillSuggestionService({ load: createSkillSuggestionContextLoader(db),
    resolve: () => roles.resolve("skillSuggestions"), decide: createPrismaOptionalDecisionService(db) });
}
