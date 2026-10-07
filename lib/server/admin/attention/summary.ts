import {
  adminAttentionItemSource,
  type AdminAttentionSource,
  type AdminAttentionSummary
} from "../../../contracts/adminAttention";
import type { AdminProviderConnection } from "../../../contracts/adminProviders";
import type { HealthFinding } from "./healthRules";
import { deriveAdminAttentionItems } from "./service";

/** The badge tolerates a minute of staleness; every administrator's shell shares one read. */
export const ADMIN_ATTENTION_SUMMARY_TTL_MS = 60_000;

/** Only the cheap sources: telemetry counters and the provider list with its key checks. */
export type AdminAttentionSummarySources = Readonly<{
  health(): Promise<readonly HealthFinding[]>;
  providers(): Promise<readonly AdminProviderConnection[]>;
}>;

export type AdminAttentionSummaryService = Readonly<{
  read(): Promise<AdminAttentionSummary>;
}>;

/**
 * Severity counts for the app-wide administrator badge, cached in process. The
 * counts are installation-wide (no source here depends on the acting
 * administrator), so one cached value serves every administrator. A read where
 * every source failed is not cached and rejects.
 */
export function createAdminAttentionSummaryService(input: Readonly<{
  now?: () => Date;
  sources: AdminAttentionSummarySources;
  ttlMs?: number;
}>): AdminAttentionSummaryService {
  const now = input.now ?? (() => new Date());
  const ttlMs = input.ttlMs ?? ADMIN_ATTENTION_SUMMARY_TTL_MS;
  let cached: Readonly<{ expiresAt: number; summary: AdminAttentionSummary }> | null = null;
  let pending: Promise<AdminAttentionSummary> | null = null;

  async function compute(): Promise<AdminAttentionSummary> {
    const unavailable: AdminAttentionSource[] = [];
    async function load<T>(source: AdminAttentionSource, loader: () => Promise<T>): Promise<T | null> {
      try {
        return await loader();
      } catch {
        unavailable.push(source);
        return null;
      }
    }
    const [health, providers] = await Promise.all([
      load("health", () => input.sources.health()),
      load("providers", () => input.sources.providers())
    ]);
    if (health === null && providers === null) throw new Error("admin_attention_summary_unavailable");
    const items = deriveAdminAttentionItems({
      actingAdminUserId: "",
      dashboard: null,
      email: null,
      health,
      knowledge: null,
      mcp: null,
      memory: null,
      providers,
      search: null,
      systemRoles: null
    });
    return {
      bad: items.filter((item) => item.severity === "bad").length,
      checkedAt: now().toISOString(),
      health: health === null ? null : items.filter((item) => adminAttentionItemSource(item) === "health").length,
      unavailable,
      warn: items.filter((item) => item.severity === "warn").length
    };
  }

  return {
    async read() {
      if (cached && cached.expiresAt > now().getTime()) return cached.summary;
      pending ??= compute()
        .then((summary) => {
          cached = { expiresAt: now().getTime() + ttlMs, summary };
          return summary;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    }
  };
}
