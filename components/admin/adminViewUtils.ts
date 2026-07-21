import type { AdminCatalog, AdminMembership } from "@/lib/contracts/admin";

export function formatDate(value: string | null): string {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function formatTime(value: Date | null): string {
  if (!value) {
    return "Not loaded";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined).format(value);
}

export function providerDisplayName(catalog: Pick<AdminCatalog, "providers">, providerId: string): string {
  return catalog.providers.find((provider) => provider.id === providerId)?.name ?? providerId;
}

export function modelDisplayName(
  catalog: Pick<AdminCatalog, "models">,
  model: { modelId: string; provider: string }
): string {
  return (
    catalog.models.find((candidate) => candidate.provider === model.provider && candidate.modelId === model.modelId)
      ?.displayName ?? model.modelId
  );
}

export function searchStrategyDisplayName(catalog: Pick<AdminCatalog, "searchStrategies">, strategyId: string): string {
  return catalog.searchStrategies.find((strategy) => strategy.strategyId === strategyId)?.displayName ?? strategyId;
}

export function groupLabel(groups: AdminMembership[]): string {
  return groups.length ? groups.map((group) => group.name).join(", ") : "No groups";
}

export function normalizedRuleValue(kind: "domain" | "email", value: string): string {
  const normalized = value.trim().toLowerCase();

  return kind === "domain" ? normalized.replace(/^@+/, "") : normalized;
}
