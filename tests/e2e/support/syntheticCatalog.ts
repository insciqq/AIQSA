import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { builtInSearchDraft, normalizeSearchDraft, searchDraftHash } from "../../../lib/server/search/configuration";
import { searchValidationFingerprint } from "../../../lib/server/search/probeBinding";
import {
  createTestProviderExecutionAuthority,
  deleteTestProviderExecutionAuthority,
  type TestProviderExecutionAuthority
} from "../../support/providerExecutionAuthority";

/**
 * Catalog-only provider fixtures for browser specs on the Fake QSA stand,
 * which otherwise offers one answer model and no Search source:
 * - a second answer model a user can pick in the header (never sent to);
 * - a Search source the Fake QSA model can carry, reached through a
 *   provider-model client route. The fake model never calls a tool, so a run
 *   that carries the source records it without executing a search.
 * Both sit behind a synthetic credential on an unresolvable `.test` host and
 * are visible to every full-access member while they exist. Names carry the
 * label; `cleanup` removes exactly what was created and must run after the
 * chats that used them are gone.
 */

export type CatalogOnlyAnswerModel = Readonly<{
  cleanup(): Promise<void>;
  /** The provider id the model picker groups the model under. */
  connectionId: string;
  displayName: string;
  providerModelId: string;
}>;

export type CatalogOnlySearchSource = Readonly<{
  cleanup(): Promise<void>;
  displayName: string;
  /** The option id a Search plan names. */
  optionId: string;
}>;

const capabilities = {
  contextWindow: 16_384,
  nativePdfInput: false,
  nativeSearch: false,
  pdf: false,
  reasoning: false,
  vision: false
};

async function markAvailable(prisma: PrismaClient, authority: TestProviderExecutionAuthority): Promise<void> {
  await prisma.providerModelCredentialCheck.create({
    data: { ...authority, checkedAt: new Date(), connectionVersion: 1, modelVersion: 1, status: "available" }
  });
}

async function removeAuthority(prisma: PrismaClient, authority: TestProviderExecutionAuthority): Promise<void> {
  await prisma.providerModelCredentialCheck.deleteMany({ where: { connectionId: authority.connectionId } });
  await deleteTestProviderExecutionAuthority(prisma, authority);
}

/** An answer model on an OpenAI-compatible synthetic connection, offered to full-access members. */
export async function createCatalogOnlyAnswerModel(prisma: PrismaClient, label: string): Promise<CatalogOnlyAnswerModel> {
  const suffix = randomUUID().slice(0, 8);
  const authority = await createTestProviderExecutionAuthority(prisma, `e2e-${label}`);
  const displayName = `E2E ${label} model ${suffix}`;
  const configuration = {
    adapterKind: "openai_responses_compatible",
    answerSelectable: true,
    capabilities,
    defaultParams: {},
    modelClass: "answer",
    upstreamModelId: `e2e-${label}-${suffix}`
  };
  try {
    await prisma.providerModel.update({
      data: {
        activeConfig: configuration,
        capabilities: configuration.capabilities,
        displayName,
        draftConfig: configuration,
        modelId: configuration.upstreamModelId
      },
      where: { id: authority.providerModelId }
    });
    await markAvailable(prisma, authority);
  } catch (error) {
    await removeAuthority(prisma, authority).catch(() => undefined);
    throw error;
  }
  return {
    cleanup: () => removeAuthority(prisma, authority),
    connectionId: authority.connectionId,
    displayName,
    providerModelId: authority.providerModelId
  };
}

/**
 * A Perplexity-kind Search source whose technical model is a synthetic
 * OpenRouter-family model, so the Fake QSA model reaches it as a client route.
 */
export async function createCatalogOnlySearchSource(prisma: PrismaClient, label: string): Promise<CatalogOnlySearchSource> {
  const suffix = randomUUID().slice(0, 8);
  const optionId = `e2e-${label}-search-${suffix}`;
  const displayName = `E2E ${label} Search ${suffix}`;
  const authority = await createTestProviderExecutionAuthority(prisma, `e2e-${label}-search`);
  const technical = {
    adapterKind: "openrouter_chat_completions",
    answerSelectable: false,
    capabilities: { ...capabilities, nativeSearch: true },
    defaultParams: {},
    modelClass: "answer",
    // Every OpenRouter chat model needs a routing choice, or its configuration
    // is invalid and the route (and with it the source) leaves the catalog.
    openRouterRouting: { mode: "automatic", providers: [] },
    upstreamModelId: `e2e-${label}-search-${suffix}`
  };
  const cleanup = async () => {
    await prisma.searchStrategy.updateMany({ data: { activeRevisionId: null }, where: { strategyId: optionId } });
    await prisma.searchIntegrationRevision.deleteMany({ where: { searchStrategy: { strategyId: optionId } } });
    await prisma.searchStrategy.deleteMany({ where: { strategyId: optionId } });
    await prisma.searchOption.deleteMany({ where: { optionId } });
    await removeAuthority(prisma, authority);
  };
  try {
    await prisma.providerConnection.update({ data: { family: "openrouter" }, where: { id: authority.connectionId } });
    await prisma.providerModel.update({
      data: {
        activeConfig: technical,
        capabilities: technical.capabilities,
        displayName: `${displayName} route`,
        draftConfig: technical,
        modelId: technical.upstreamModelId,
        provider: "openrouter"
      },
      where: { id: authority.providerModelId }
    });
    await markAvailable(prisma, authority);
    const option = await prisma.searchOption.create({
      data: {
        description: "Synthetic Search source for browser specs",
        displayName,
        kind: "perplexity_search",
        optionId,
        sourceConnectionId: authority.connectionId
      },
      select: { id: true }
    });
    const draft = normalizeSearchDraft(builtInSearchDraft({
      config: {},
      kind: "perplexity_tool_search",
      providerModelId: authority.providerModelId
    }));
    const strategy = await prisma.searchStrategy.create({
      data: {
        adapterKind: draft.adapterKind,
        config: {},
        credentialMode: draft.credentialMode,
        description: "Synthetic Search source for browser specs",
        displayName,
        draft: draft as unknown as Prisma.InputJsonValue,
        kind: "perplexity_tool_search",
        modelId: technical.upstreamModelId,
        provider: authority.connectionId,
        providerModelId: authority.providerModelId,
        searchOptionId: option.id,
        strategyId: optionId
      },
      select: { id: true }
    });
    const evidence = { method: "seed", status: "available" };
    const revision = await prisma.searchIntegrationRevision.create({
      data: {
        adapterKind: draft.adapterKind,
        configuration: draft as unknown as Prisma.InputJsonValue,
        credentialMode: draft.credentialMode,
        draftHash: searchDraftHash(draft),
        providerModelId: authority.providerModelId,
        revisionNumber: 1,
        searchStrategyId: strategy.id,
        validationEvidence: evidence,
        validationFingerprint: searchValidationFingerprint(evidence)
      },
      select: { id: true }
    });
    await prisma.searchStrategy.update({
      data: { activatedAt: new Date(), activeRevisionId: revision.id },
      where: { id: strategy.id }
    });
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
  return { cleanup, displayName, optionId };
}
