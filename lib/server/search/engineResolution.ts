import { Prisma } from "@prisma/client";
import {
  hostedSearchProtocolUsable,
  resolveSearchEngine,
  type SearchEngineCandidate,
  type SearchEngineResolution
} from "../../domain/search";
import { normalizeProviderModelConfiguration } from "../providers/providerConfiguration";
import { normalizeSearchDraft, searchStrategyKind, technicalSearchModelSupports } from "./configuration";

/**
 * The installation's one Search engine (operator decisions 2026-11-26): the administrator's choice, else the first
 * ready source in the default order (`resolveSearchEngine`), an optional backup for failed calls, and the switch that
 * lets OpenAI-protocol answer models search inside their own answer. Admission, the user's catalog and Admin › Search
 * read it through this module, so all three name the same engine; whether one user's credentials reach it is
 * admission's to check.
 */

export const INSTALLATION_SEARCH_POLICY_ID = "installation";

export type InstallationSearchPolicy = Readonly<{
  backupOptionId: string | null;
  /** Null: the default order picks the engine. */
  engineOptionId: string | null;
  /** GPT on an OpenAI-protocol connection with verified hosted search searches inside its answer (default on). */
  inAnswerSearch: boolean;
}>;

export const DEFAULT_INSTALLATION_SEARCH_POLICY: InstallationSearchPolicy = Object.freeze({
  backupOptionId: null,
  engineOptionId: null,
  inAnswerSearch: true
});

function boundedOptionId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 160 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

/** The policy row's engine columns; a missing row is the default policy. */
export function decodeInstallationSearchPolicy(row: unknown): InstallationSearchPolicy {
  if (typeof row !== "object" || row === null) return DEFAULT_INSTALLATION_SEARCH_POLICY;
  const value = row as Record<string, unknown>;
  return {
    backupOptionId: boundedOptionId(value.backupOptionId),
    engineOptionId: boundedOptionId(value.engineOptionId),
    inAnswerSearch: value.inAnswerSearch !== false
  };
}

export const installationSearchPolicySelect = {
  backupOptionId: true,
  engineOptionId: true,
  inAnswerSearch: true
} satisfies Prisma.SearchPolicySelect;

/** A Search source row with its live routes, in the shape every reader loads. */
export type SearchOptionRouteRow = Readonly<{
  archivedAt: Date | null;
  createdAt: Date;
  displayName: string;
  enabled: boolean;
  id: string;
  kind: string;
  optionId: string;
  sourceConnectionId: string | null;
  strategies: ReadonlyArray<Readonly<{
    activeRevision: null | Readonly<{
      adapterKind: string;
      configuration: unknown;
      credentialMode: string;
      id: string;
      providerModelId: string | null;
    }>;
    activeRevisionId: string | null;
    adapterKind: string;
    archivedAt: Date | null;
    credentialMode: string;
    enabled: boolean;
    id: string;
    kind: string;
    providerModelId: string | null;
    strategyId: string;
  }>>;
}>;

export const searchOptionRouteInclude = {
  strategies: {
    include: {
      activeRevision: {
        select: { adapterKind: true, configuration: true, credentialMode: true, id: true, providerModelId: true }
      }
    },
    orderBy: [{ createdAt: "asc" }, { strategyId: "asc" }],
    where: { activeRevisionId: { not: null }, archivedAt: null, enabled: true }
  }
} satisfies Prisma.SearchOptionInclude;

export type ResolvedSearchRoute<Option extends SearchOptionRouteRow = SearchOptionRouteRow> = Readonly<{
  draft: ReturnType<typeof normalizeSearchDraft>;
  revisionId: string;
  strategy: Option["strategies"][number];
}>;

/** A source this release can search through: enabled, live, of a known kind and on its connection. */
export function supportedSearchOption(option: SearchOptionRouteRow): boolean {
  if (!option.enabled || option.archivedAt !== null) return false;
  return (
    option.kind === "web_search" ||
    option.kind === "deepseek_search_api" ||
    option.kind === "gemini_google_search" ||
    option.kind === "perplexity_search"
  ) && typeof option.sourceConnectionId === "string" && option.sourceConnectionId.length > 0;
}

/** A route's active revision, when it is live and agrees with the row it belongs to. */
export function normalizeActiveSearchRoute<Option extends SearchOptionRouteRow>(
  strategy: Option["strategies"][number]
): ResolvedSearchRoute<Option> | null {
  const revision = strategy.activeRevision;
  if (
    !strategy.enabled ||
    strategy.archivedAt !== null ||
    !strategy.activeRevisionId ||
    !revision ||
    revision.id !== strategy.activeRevisionId
  ) {
    return null;
  }
  let draft: ReturnType<typeof normalizeSearchDraft>;
  try {
    draft = normalizeSearchDraft(revision.configuration);
  } catch {
    return null;
  }
  if (
    revision.adapterKind !== draft.adapterKind ||
    revision.credentialMode !== draft.credentialMode ||
    revision.providerModelId !== draft.providerModelId ||
    strategy.adapterKind !== draft.adapterKind ||
    strategy.credentialMode !== draft.credentialMode ||
    strategy.providerModelId !== draft.providerModelId ||
    strategy.kind !== searchStrategyKind(draft.protocol, draft.adapterKind)
  ) {
    return null;
  }
  return { draft, revisionId: revision.id, strategy };
}

/** Whether a route carries the source's own kind of search. */
export function routeBelongsToOption(option: SearchOptionRouteRow, route: ResolvedSearchRoute): boolean {
  if (option.kind === "web_search") {
    return route.draft.protocol === "anthropic_web_search" ||
      route.draft.protocol === "openai_responses_web_search" ||
      route.draft.adapterKind === "provider_model_client" && route.draft.protocol === "openrouter_web_search";
  }
  if (option.kind === "gemini_google_search") {
    return route.draft.protocol === "gemini_google_search";
  }
  if (option.kind === "deepseek_search_api") {
    return route.draft.adapterKind === "provider_model_client" &&
      route.draft.protocol === "deepseek_search_api";
  }
  return option.kind === "perplexity_search" &&
    route.draft.adapterKind === "provider_model_client" &&
    route.draft.protocol === "openrouter_perplexity_chat";
}

/** A source's routes of its own kind, one per adapter kind; null when two compete. */
export function searchOptionRoutes<Option extends SearchOptionRouteRow>(option: Option): ResolvedSearchRoute<Option>[] | null {
  const routes = option.strategies.flatMap((strategy) => {
    const route = normalizeActiveSearchRoute<Option>(strategy);
    return route && routeBelongsToOption(option, route as ResolvedSearchRoute) ? [route] : [];
  });
  const adapterKinds = new Set(routes.map((route) => route.draft.adapterKind));
  return adapterKinds.size === routes.length ? routes : null;
}

/** A client route's technical model, as the reader knows it: ready when live on the source's connection. */
export type TechnicalSearchModelReadiness = (input: Readonly<{
  connectionId: string;
  protocol: ReturnType<typeof normalizeSearchDraft>["protocol"];
  providerModelId: string;
}>) => boolean;

/** One source the engine may be: its client route and whether that route can search now. */
export type SearchEngineOption<Option extends SearchOptionRouteRow = SearchOptionRouteRow> = SearchEngineCandidate & Readonly<{
  displayName: string;
  option: Option;
  route: ResolvedSearchRoute<Option> | null;
}>;

/** A source with OpenAI's hosted search on its connection, which an OpenAI-protocol answer model there may use. */
export type HostedSearchOption<Option extends SearchOptionRouteRow = SearchOptionRouteRow> = Readonly<{
  option: Option;
  route: ResolvedSearchRoute<Option>;
}>;

export type InstallationSearch<Option extends SearchOptionRouteRow = SearchOptionRouteRow> = Readonly<{
  /** The first hosted source of each connection, by its connection id. */
  hosted: ReadonlyMap<string, HostedSearchOption<Option>>;
  policy: InstallationSearchPolicy;
  resolution: SearchEngineResolution<SearchEngineOption<Option>>;
}>;

function sourceOrder(left: SearchOptionRouteRow, right: SearchOptionRouteRow): number {
  return left.createdAt.getTime() - right.createdAt.getTime() ||
    (left.optionId < right.optionId ? -1 : left.optionId > right.optionId ? 1 : 0);
}

/**
 * The engine and hosted sources from the sources a reader loaded, oldest first. A source qualifies as an engine by
 * its client route, ready when its technical model is (`technicalModelReady`); a source without one is listed, never
 * ready, so a chosen hosted-only source reads as unavailable rather than as missing.
 */
export function resolveInstallationSearch<Option extends SearchOptionRouteRow>(input: Readonly<{
  options: readonly Option[];
  policy: InstallationSearchPolicy;
  technicalModelReady: TechnicalSearchModelReadiness;
}>): InstallationSearch<Option> {
  const options = input.options.filter(supportedSearchOption).sort(sourceOrder);
  const candidates: SearchEngineOption<Option>[] = [];
  const hosted = new Map<string, HostedSearchOption<Option>>();
  for (const option of options) {
    const routes = searchOptionRoutes(option);
    if (!routes) continue;
    const client = routes.find((route) => route.draft.adapterKind === "provider_model_client") ?? null;
    const ready = Boolean(client?.draft.providerModelId && option.sourceConnectionId && input.technicalModelReady({
      connectionId: option.sourceConnectionId,
      protocol: client.draft.protocol,
      providerModelId: client.draft.providerModelId
    }));
    candidates.push({
      displayName: option.displayName,
      openRouterEngine: client?.draft.openRouterWebSearch?.engine ?? null,
      option,
      optionId: option.optionId,
      protocol: client?.draft.protocol ?? "",
      ready,
      route: client
    });
    const hostedRoute = routes.find((route) => route.draft.adapterKind === "answer_provider_hosted" &&
      hostedSearchProtocolUsable(route.draft.protocol));
    if (option.kind === "web_search" && hostedRoute && option.sourceConnectionId && !hosted.has(option.sourceConnectionId)) {
      hosted.set(option.sourceConnectionId, { option, route: hostedRoute });
    }
  }
  return {
    hosted,
    policy: input.policy,
    resolution: resolveSearchEngine({
      backupOptionId: input.policy.backupOptionId,
      candidates,
      engineOptionId: input.policy.engineOptionId
    })
  };
}

/** Whether a stored model row can carry a protocol's client route: live, on the source's connection, of a fitting adapter. */
export function technicalSearchModelRowReady(
  model: Readonly<{ activeConfig: unknown; connectionId: string }> | undefined,
  input: Parameters<TechnicalSearchModelReadiness>[0]
): boolean {
  if (!model || model.connectionId !== input.connectionId) return false;
  try {
    const configuration = normalizeProviderModelConfiguration(model.activeConfig);
    return technicalSearchModelSupports(input.protocol, {
      adapterKind: configuration.adapterKind,
      nativeSearch: configuration.capabilities.nativeSearch
    });
  } catch {
    return false;
  }
}

export type InstallationSearchDb = Pick<Prisma.TransactionClient, "providerModel" | "searchOption" | "searchPolicy">;

/** The installation's Search as admission reads it: the policy, every live source and the technical models behind them. */
export async function loadInstallationSearch(db: InstallationSearchDb): Promise<InstallationSearch> {
  // One statement at a time: admission also reads this inside its binding transaction.
  const policyRow = await db.searchPolicy.findUnique({
    select: installationSearchPolicySelect,
    where: { id: INSTALLATION_SEARCH_POLICY_ID }
  });
  const options = await db.searchOption.findMany({
    include: searchOptionRouteInclude,
    orderBy: [{ createdAt: "asc" }, { optionId: "asc" }],
    where: { archivedAt: null, enabled: true }
  }) as SearchOptionRouteRow[];
  const technicalIds = [...new Set(options.flatMap((option) => option.strategies.flatMap((strategy) =>
    strategy.adapterKind === "provider_model_client" && strategy.providerModelId ? [strategy.providerModelId] : [])))];
  const models = technicalIds.length > 0
    ? await db.providerModel.findMany({
        select: { activeConfig: true, connectionId: true, id: true },
        where: {
          activeConfig: { not: Prisma.DbNull },
          activeVersion: { gt: 0 },
          connection: { activeConfig: { not: Prisma.DbNull }, activeVersion: { gt: 0 }, enabled: true },
          enabled: true,
          id: { in: technicalIds }
        }
      })
    : [];
  const byId = new Map(models.map((model) => [model.id, model]));
  return resolveInstallationSearch({
    options,
    policy: decodeInstallationSearchPolicy(policyRow),
    technicalModelReady: (input) => technicalSearchModelRowReady(byId.get(input.providerModelId), input)
  });
}
