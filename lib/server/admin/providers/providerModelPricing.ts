import { Prisma, type ProviderModel } from "@prisma/client";
import { ADMIN_MODEL_PRICE_FIELDS, decodeAdminModelPriceChange, modelClassUsesTokenPrices,
  normalizeAdminModelPrice, type AdminModelPricing, type AdminModelTokenPrices } from "../../../contracts/adminProviderModelPrices";
import { ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS, type AdminProviderQuickSetupProviderId } from "../../../contracts/adminProviderQuickSetup";
import { catalogModelPrices, catalogModelTokenPricing } from "../../../domain/modelPrices";
import { codexLbEndpoint } from "./setupModels";

/** Stored connection columns; configurations are raw JSON as persisted. */
export type CatalogIdentityConnection = Readonly<{ family: string; activeConfig: unknown; draftConfig: unknown }>;
/** Stored row columns. `modelId` is the upstream model the row executes. */
export type CatalogIdentityRow = Readonly<{ modelClass: string; templateKey: string | null; modelId: string }>;
type StoredPricing = Pick<ProviderModel, "priceSource" | typeof ADMIN_MODEL_PRICE_FIELDS[number]> & CatalogIdentityRow;

function storedEndpoint(connection: CatalogIdentityConnection): Readonly<Record<string, unknown>> | null {
  for (const configuration of [connection.activeConfig, connection.draftConfig]) {
    if (configuration && typeof configuration === "object" && !Array.isArray(configuration)) return configuration as Record<string, unknown>;
  }
  return null;
}

/**
 * The one catalog identity of a stored answer row; only answer usage is costed
 * from token prices. A template key identifies itself. Without one, a row on a
 * codex-lb endpoint takes the OpenAI tariff of its upstream model, and a row on
 * any connection of a Quick Setup family takes that family's tariff. Everything
 * else has none. Reads stored columns only; `20260930130000_model_token_prices`
 * mirrors it in SQL.
 */
export function providerModelCatalogKey(row: CatalogIdentityRow, connection: CatalogIdentityConnection): string | null {
  if (!modelClassUsesTokenPrices(row.modelClass)) return null;
  if (row.templateKey !== null) return Object.hasOwn(catalogModelPrices, row.templateKey) ? row.templateKey : null;
  const family = connection.family === "openai_compatible" && codexLbEndpoint(storedEndpoint(connection)) ? "openai"
    : ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS.includes(connection.family as AdminProviderQuickSetupProviderId) ? connection.family : null;
  const key = family && `${family}:${row.modelId}`;
  return key && Object.hasOwn(catalogModelPrices, key) ? key : null;
}

function catalogPrices(key: string | null): AdminModelTokenPrices | null {
  if (!key) return null;
  const prices = catalogModelTokenPricing(key);
  return Object.fromEntries(ADMIN_MODEL_PRICE_FIELDS.map(field => [field, prices[field] == null ? null
    : normalizeAdminModelPrice(new Prisma.Decimal(prices[field]!).toFixed(8))!])) as AdminModelTokenPrices;
}

export function projectAdminModelPricing(model: StoredPricing, connection: CatalogIdentityConnection): AdminModelPricing {
  return { prices: Object.fromEntries(ADMIN_MODEL_PRICE_FIELDS.map(field => [field,
    model[field] === null ? null : normalizeAdminModelPrice(model[field].toFixed(8))!])) as AdminModelTokenPrices,
    source: model.priceSource, catalogPrices: catalogPrices(providerModelCatalogKey(model, connection)) };
}

/** Catalog identity comes exclusively from the stored row, never request data. */
export function resolveAdminModelPricingChange(row: CatalogIdentityRow, connection: CatalogIdentityConnection, value: unknown): AdminModelPricing | null {
  const change = decodeAdminModelPriceChange(value);
  if (!change || !modelClassUsesTokenPrices(row.modelClass)) return null;
  const catalog = catalogPrices(providerModelCatalogKey(row, connection));
  if (change.mode === "restore_catalog" && !catalog) return null;
  return { prices: change.mode === "manual" ? change.prices : catalog!,
    source: change.mode === "manual" ? "admin" : "catalog", catalogPrices: catalog };
}

/**
 * Prices of a new row created without explicit prices: the catalog tariff of
 * its identity, otherwise an unknown administrator-owned price.
 */
export function initialAdminModelPricing(row: CatalogIdentityRow, connection: CatalogIdentityConnection): AdminModelPricing | null {
  if (!modelClassUsesTokenPrices(row.modelClass)) return null;
  const catalog = catalogPrices(providerModelCatalogKey(row, connection));
  return catalog ? { prices: catalog, source: "catalog", catalogPrices: catalog } : null;
}

export function adminModelPricingColumns(pricing: AdminModelPricing) {
  return { ...pricing.prices, priceSource: pricing.source };
}
