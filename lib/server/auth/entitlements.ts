export type AccessGrantLike = {
  enabled: boolean;
  groupId?: string | null;
  modelId?: string | null;
  provider?: string | null;
  searchStrategy?: string | null;
  userId?: string | null;
};

export type ResolvedEntitlements = {
  modelKeys: Set<string>;
  providerKeys: Set<string>;
  searchStrategies: Set<string>;
};

export type RunAccessRequest = {
  modelId: string;
  provider: string;
  searchStrategy?: string | null;
};

export type RunAccessResult =
  | {
      ok: true;
    }
  | {
      code: "model_not_available" | "search_strategy_not_available";
      ok: false;
    };

export function modelKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

export function resolveEntitlements(
  userId: string,
  groupIds: string[],
  grants: AccessGrantLike[]
): ResolvedEntitlements {
  const groupIdSet = new Set(groupIds);
  const entitlements: ResolvedEntitlements = {
    modelKeys: new Set(),
    providerKeys: new Set(),
    searchStrategies: new Set()
  };

  for (const grant of grants) {
    if (!grant.enabled) {
      continue;
    }

    const appliesToUser = grant.userId === userId;
    const appliesToGroup = Boolean(grant.groupId && groupIdSet.has(grant.groupId));

    if (!appliesToUser && !appliesToGroup) {
      continue;
    }

    if (grant.provider && grant.modelId) {
      entitlements.modelKeys.add(modelKey(grant.provider, grant.modelId));
    } else if (grant.provider) {
      entitlements.providerKeys.add(grant.provider);
    }

    if (grant.searchStrategy) {
      entitlements.searchStrategies.add(grant.searchStrategy);
    }
  }

  return entitlements;
}

export function canAccessModel(
  entitlements: ResolvedEntitlements,
  provider: string,
  modelId: string
): boolean {
  return entitlements.providerKeys.has(provider) || entitlements.modelKeys.has(modelKey(provider, modelId));
}

export function canAccessSearchStrategy(
  entitlements: ResolvedEntitlements,
  searchStrategy: string | null | undefined
): boolean {
  return !searchStrategy || searchStrategy === "search-disabled" || entitlements.searchStrategies.has(searchStrategy);
}

export function validateRunAccess(
  entitlements: ResolvedEntitlements,
  request: RunAccessRequest
): RunAccessResult {
  if (!canAccessModel(entitlements, request.provider, request.modelId)) {
    return {
      code: "model_not_available",
      ok: false
    };
  }

  if (!canAccessSearchStrategy(entitlements, request.searchStrategy)) {
    return {
      code: "search_strategy_not_available",
      ok: false
    };
  }

  return {
    ok: true
  };
}
