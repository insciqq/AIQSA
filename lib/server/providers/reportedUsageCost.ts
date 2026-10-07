function usdAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function decimal(value: number): Readonly<{ digits: bigint; exponent: number }> {
  // String() gives the shortest decimal that round-trips the number: the
  // provider's own JSON text.
  const [, whole, fraction = "", exponent = "0"] = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/u.exec(String(value))!;
  return { digits: BigInt(whole! + fraction), exponent: Number(exponent) - fraction.length };
}

/** The exact decimal sum of two reported amounts, so binary floats cannot move
 * a half-micro boundary when the sum is later rounded to micro-dollars. */
function exactSum(left: number, right: number): number {
  const a = decimal(left);
  const b = decimal(right);
  const exponent = Math.min(a.exponent, b.exponent);
  const digits = a.digits * 10n ** BigInt(a.exponent - exponent) + b.digits * 10n ** BigInt(b.exponent - exponent);
  return Number(`${digits}e${exponent}`);
}

/**
 * The USD one call cost the installation, from an OpenRouter usage object (the
 * shape every adapter that reads `usage.cost` receives). `cost` is what
 * OpenRouter charged. A BYOK call (`is_byok: true`) runs on the installation's
 * own upstream key, which the upstream provider bills separately:
 * `cost_details.upstream_inference_cost`, so its spend is both. Any other
 * call's spend is `cost` alone; its upstream cost is what OpenRouter paid and
 * is already inside `cost`.
 *
 * Undefined: no cost reported, or a BYOK call that omits its upstream cost (no
 * usable spend; configured prices then apply). Null: a malformed amount, which
 * strict adapters reject like any other malformed usage field.
 */
export function reportedUsageCostUsd(usage: Readonly<Record<string, unknown>>): number | null | undefined {
  if (usage.cost === undefined) return undefined;
  if (!usdAmount(usage.cost)) return null;
  if (usage.is_byok !== true) return usage.cost;
  const details = usage.cost_details;
  const upstream = details && typeof details === "object" && !Array.isArray(details)
    ? (details as Readonly<Record<string, unknown>>).upstream_inference_cost : undefined;
  if (upstream === undefined || upstream === null) return undefined;
  return usdAmount(upstream) ? exactSum(usage.cost, upstream) : null;
}
