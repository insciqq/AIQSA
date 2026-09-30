/** Exact operational USD prices per million tokens, matching Decimal(18,8). */
export const ADMIN_MODEL_PRICE_FIELDS = [
  "inputTokenPriceUsdPerMillion", "cachedInputTokenPriceUsdPerMillion",
  "cacheWriteInputTokenPriceUsdPerMillion", "outputTokenPriceUsdPerMillion"
] as const;
export type AdminModelPriceField = typeof ADMIN_MODEL_PRICE_FIELDS[number];
export type AdminModelTokenPrices = Readonly<Record<AdminModelPriceField, string | null>>;
export type AdminModelPricing = Readonly<{
  prices: AdminModelTokenPrices;
  source: "catalog" | "admin";
  catalogPrices: AdminModelTokenPrices | null;
}>;
export type AdminModelPriceChange = Readonly<{ mode: "manual"; prices: AdminModelTokenPrices }> |
  Readonly<{ mode: "restore_catalog" }>;
export const EMPTY_ADMIN_MODEL_PRICES: AdminModelTokenPrices = Object.freeze({
  inputTokenPriceUsdPerMillion: null, cachedInputTokenPriceUsdPerMillion: null,
  cacheWriteInputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: null
});
export const ADMIN_MODEL_PRICE_ERROR = "Enter a non-negative decimal up to 9999999999.99999999 with at most 8 decimal places; exponent notation is not supported.";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
/** Undefined means invalid; null is unknown. Wire values never accept JSON numbers. */
export function normalizeAdminModelPrice(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 64 || !/^\d+(?:\.\d{1,8})?$/u.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".");
  const integer = whole!.replace(/^0+(?=\d)/u, "");
  if (integer.length > 10) return undefined;
  const decimal = fraction.replace(/0+$/u, "");
  return integer + (decimal ? `.${decimal}` : "");
}
export function decodeAdminModelTokenPrices(value: unknown): AdminModelTokenPrices | null {
  if (!record(value) || !exactKeys(value, ADMIN_MODEL_PRICE_FIELDS)) return null;
  const values = ADMIN_MODEL_PRICE_FIELDS.map(field => [field, normalizeAdminModelPrice(value[field])] as const);
  if (values.some(([, price]) => price === undefined)) return null;
  return Object.fromEntries(values) as AdminModelTokenPrices;
}
export function decodeAdminModelPricing(value: unknown): AdminModelPricing | null {
  if (!record(value) || !exactKeys(value, ["prices", "source", "catalogPrices"]) ||
    (value.source !== "catalog" && value.source !== "admin")) return null;
  const prices = decodeAdminModelTokenPrices(value.prices);
  const catalogPrices = value.catalogPrices === null ? null : decodeAdminModelTokenPrices(value.catalogPrices);
  if (!prices || value.catalogPrices !== null && !catalogPrices) return null;
  return { prices, source: value.source, catalogPrices };
}
export function decodeAdminModelPriceChange(value: unknown): AdminModelPriceChange | null {
  if (!record(value)) return null;
  if (value.mode === "restore_catalog" && exactKeys(value, ["mode"])) return { mode: "restore_catalog" };
  if (value.mode !== "manual" || !exactKeys(value, ["mode", "prices"])) return null;
  const prices = decodeAdminModelTokenPrices(value.prices);
  return prices ? { mode: "manual", prices } : null;
}
/**
 * The field a server-side price rejection belongs to: the first price of a
 * manual change that is not an exact decimal. Null for a malformed change.
 */
export function invalidAdminModelPriceField(value: unknown): AdminModelPriceField | null {
  if (!record(value) || value.mode !== "manual" || !record(value.prices)) return null;
  const prices = value.prices;
  return ADMIN_MODEL_PRICE_FIELDS.find(field => normalizeAdminModelPrice(prices[field]) === undefined) ?? null;
}
export function isAdminModelPriceField(value: unknown): value is AdminModelPriceField {
  return ADMIN_MODEL_PRICE_FIELDS.includes(value as AdminModelPriceField);
}
/**
 * Only answer usage is costed from token prices. Decision (Jev) cost comes
 * from the provider-reported amount, so its rows carry no editable price.
 */
export function modelClassUsesTokenPrices(modelClass: string): boolean {
  return modelClass === "answer";
}

export function adminModelPriceChangeMatches(change: AdminModelPriceChange, pricing: AdminModelPricing): boolean {
  const expected = change.mode === "manual" ? decodeAdminModelTokenPrices(change.prices) : pricing.catalogPrices;
  return pricing.source === (change.mode === "manual" ? "admin" : "catalog") && expected !== null &&
    ADMIN_MODEL_PRICE_FIELDS.every(field => expected[field] === normalizeAdminModelPrice(pricing.prices[field]));
}
