import type { AdminProviderModel } from "@/lib/contracts/adminProviders";
import type { AdminProviderModelSaveReceipt } from "@/lib/contracts/adminProviderModelSave";
import { modelFormFrom, type ModelForm } from "./modelSheetView";
import { ADMIN_MODEL_PRICE_FIELDS, normalizeAdminModelPrice } from "@/lib/contracts/adminProviderModelPrices";

export type AdminProviderModelPersistence = Readonly<{
  receipt: AdminProviderModelSaveReceipt | null;
  model: AdminProviderModel | null;
}>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

export function modelSaveValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function sameField(key: keyof ModelForm, left: ModelForm, right: ModelForm): boolean {
  if (key === "prices") return ADMIN_MODEL_PRICE_FIELDS.every(field =>
    normalizeAdminModelPrice(left.prices[field].trim() || null) === normalizeAdminModelPrice(right.prices[field].trim() || null));
  if (key === "defaultParamsText") {
    try { return modelSaveValuesEqual(JSON.parse(left[key]), JSON.parse(right[key])); } catch { return false; }
  }
  if (key === "displayName" || key === "upstreamModelId" || key === "reasoningEffortPath" || key === "reasoningModePath") {
    return left[key].trim() === right[key].trim();
  }
  return modelSaveValuesEqual(left[key], right[key]);
}

/** Only this submission's proof may advance its baseline; the live draft stays untouched. */
export function reconcileModelForm(baseline: ModelForm, submitted: ModelForm, persistence: AdminProviderModelPersistence): {
  baseline: ModelForm; guardModel: AdminProviderModel | null; confirmed: boolean; complete: boolean;
} {
  const server = persistence.model ? modelFormFrom(persistence.model) : null;
  const next = { ...baseline };
  let confirmed = false;
  for (const key of Object.keys(submitted) as Array<keyof ModelForm>) {
    if (modelSaveValuesEqual(submitted[key], baseline[key])) continue;
    const acknowledged = persistence.receipt && (key === "prices"
      ? persistence.receipt.pricing && ADMIN_MODEL_PRICE_FIELDS.every(field =>
        normalizeAdminModelPrice(submitted.prices[field].trim() || null) === persistence.receipt!.pricing!.prices[field])
      : key === "priceSource" ? persistence.receipt.pricing?.source === submitted.priceSource
      : key === "displayName" || persistence.receipt.saved === "configuration");
    if (acknowledged || server && sameField(key, submitted, server)) {
      Object.assign(next, { [key]: submitted[key] });
      confirmed = true;
    }
  }
  const equals = (form: ModelForm) => (Object.keys(submitted) as Array<keyof ModelForm>).every((key) => sameField(key, next, form));
  return { baseline: next, confirmed, complete: equals(submitted),
    guardModel: server && equals(server) ? persistence.model : null };
}
