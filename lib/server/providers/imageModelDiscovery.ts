import type { AdminImageDiscoveredEndpoint, AdminImageDiscoveredModel } from "../../contracts/adminProviders";
import { IMAGE_PARAMETER_NAMES, normalizeImageModelConfiguration, type ImageParameterDefinitions } from "../../contracts/imageGeneration";
import { createProviderSafeFetch } from "./providerSafeFetch";
import { resolveProviderCredentialSource, type ProviderCredentialSource } from "./providerCredentialSource";
import { readBoundedResponseText, withTimeoutSignal } from "./network";
import type { ProviderConnectionConfiguration } from "./providerConfiguration";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const safeText = (value: unknown): string | null => typeof value === "string" && value.trim() && value.length <= 256 &&
  !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : null;

/** Unknown passthrough settings never become executable model overrides. */
export function imageParametersFromCatalog(value: unknown): ImageParameterDefinitions {
  if (!record(value)) return {};
  const parameters: ImageParameterDefinitions = {};
  for (const name of IMAGE_PARAMETER_NAMES) {
    const raw = value[name];
    if (!record(raw)) continue;
    const definition = raw.type === "boolean" && name === "seed" ? { type: "range", min: 0, max: 2_147_483_647 }
      : name === "output_format" && raw.type === "enum" && Array.isArray(raw.values)
        ? { ...raw, values: raw.values.filter((format) => ["png", "jpeg", "webp"].includes(String(format))) }
        : raw;
    try {
      Object.assign(parameters, normalizeImageModelConfiguration({ profile: "openrouter", parameters: { [name]: definition } }).parameters);
    } catch { /* A malformed optional hint cannot confer a capability. */ }
  }
  return parameters;
}

export function imageModelsFromCatalog(value: unknown, family: string): AdminImageDiscoveredModel[] {
  if (!record(value)) throw new Error("image_catalog_invalid");
  const entries = family === "gemini" ? value.models : value.data;
  if (!Array.isArray(entries) || entries.length > 1000) throw new Error("image_catalog_invalid");
  const models: AdminImageDiscoveredModel[] = [];
  const gateway = family === "openai_compatible" && entries.length > 0 && entries.every((entry: unknown) => record(entry) && entry.owned_by === "codex-lb");
  for (const entry of entries) {
    if (!record(entry)) continue;
    const id = safeText(family === "gemini" ? String(entry.name ?? "").replace(/^models\//u, "") : entry.id);
    if (!id) continue;
    const architecture = record(entry.architecture) ? entry.architecture : {};
    const imageOutput = Array.isArray(architecture.output_modalities) && architecture.output_modalities.includes("image");
    const parameters = record(entry.supported_parameters) ? entry.supported_parameters : {};
    const vectorOnly = record(parameters.output_format) && Array.isArray(parameters.output_format.values) &&
      parameters.output_format.values.every((format: unknown) => format === "svg");
    if (family === "openrouter") {
      if (!imageOutput || vectorOnly) continue;
      models.push({ id, name: safeText(entry.name) ?? id, source: "catalog", image: { profile: "openrouter", parameters: imageParametersFromCatalog(parameters) },
        editing: Array.isArray(architecture.input_modalities) && architecture.input_modalities.includes("image") });
    } else if (family === "gemini" && id.startsWith("gemini-") && id.includes("-image")) {
      models.push({ id, name: safeText(entry.displayName) ?? id, source: "catalog", image: { profile: "gemini" }, editing: true });
    } else if ((family === "openai" || family === "openai_compatible") && (id.startsWith("gpt-image-") || imageOutput)) {
      models.push({ id, name: safeText(entry.name) ?? id, source: "catalog", image: { profile: family === "openai" ? "openai" : gateway ? "codex_lb" : "openai_compatible" }, editing: true });
    }
  }
  // codex-lb's chat catalog omits the public Images API models. These are candidates,
  // never image capability evidence; independent live probes must verify them.
  if (gateway) for (const id of ["gpt-image-2", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"]) {
    if (!models.some((model) => model.id === id)) models.push({ id, name: id, image: { profile: "codex_lb" }, editing: true, source: "preset" });
  }
  return [...new Map(models.map((model) => [model.id, model])).values()];
}

export function createImageModelDiscovery(input: {
  connection: ProviderConnectionConfiguration; family: string; secret: ProviderCredentialSource | null;
  fetchFn?: typeof fetch;
}) {
  const fetchFn = input.fetchFn ?? createProviderSafeFetch({ configuration: input.connection });
  async function load(path: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = withTimeoutSignal(signal, input.connection.responseTimeoutMs);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (input.connection.authenticationMode !== "none") {
        const secret = await resolveProviderCredentialSource(input.secret ?? "", "image_catalog_failed");
        headers[input.family === "gemini" ? "x-goog-api-key" : "authorization"] = input.family === "gemini" ? secret : `Bearer ${secret}`;
      }
      const response = await fetchFn(`${input.connection.apiRoot}/${path}`, { method: "GET", headers, signal: timeout.signal, redirect: "error" });
      const text = await readBoundedResponseText(response, { maxBytes: 4 * 1024 * 1024, signal: timeout.signal });
      if (!response.ok) throw new Error("image_catalog_failed");
      return JSON.parse(text) as unknown;
    } catch { throw new Error("image_catalog_failed"); } finally { timeout.clear(); }
  }
  return {
    async models(signal?: AbortSignal): Promise<AdminImageDiscoveredModel[]> {
      if (!["openai", "openai_compatible", "gemini", "openrouter"].includes(input.family)) return [];
      return imageModelsFromCatalog(await load(input.family === "openrouter" ? "images/models" : input.family === "gemini" ? "models?pageSize=1000" : "models", signal), input.family);
    },
    async endpoints(modelId: string, signal?: AbortSignal): Promise<AdminImageDiscoveredEndpoint[]> {
      if (input.family !== "openrouter" || !/^[a-zA-Z0-9._~:-]+\/[a-zA-Z0-9._~:-]+$/u.test(modelId) || modelId.length > 256) throw new Error("image_catalog_failed");
      const value = await load(`images/models/${modelId.split("/").map(encodeURIComponent).join("/")}/endpoints`, signal);
      if (!record(value) || !Array.isArray(value.endpoints) || value.endpoints.length > 128) throw new Error("image_catalog_invalid");
      return value.endpoints.flatMap((entry: unknown) => {
        if (!record(entry)) return [];
        const tag = safeText(entry.provider_tag);
        return tag ? [{ tag, name: safeText(entry.provider_name) ?? tag, image: {
          profile: "openrouter" as const, parameters: imageParametersFromCatalog(entry.supported_parameters)
        } }] : [];
      });
    }
  };
}
