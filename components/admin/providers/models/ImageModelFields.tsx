"use client";

import { useEffect, useMemo, useState } from "react";
import { discoverAdminImageEndpoints, discoverAdminImageModels } from "@/components/admin/adminProvidersApi";
import { inputClass } from "@/components/admin/adminPrimitives";
import { AdminSearchablePicker } from "@/components/admin/AdminSearchablePicker";
import type { AdminImageDiscoveredEndpoint, AdminImageDiscoveredModel, AdminProviderConnection, AdminProviderCredential } from "@/lib/contracts/adminProviders";
import { imageModelConfiguration } from "@/lib/domain/imageModels";
import type { ImageGenerationParameters, ImageParameterDefinitions } from "@/lib/contracts/imageGeneration";
import type { ModelForm } from "./modelSheetView";
import { ImageParameterFields } from "./ImageParameterFields";

function sharedParameters(endpoints: readonly AdminImageDiscoveredEndpoint[]): ImageParameterDefinitions {
  const common = { ...endpoints[0]?.image.parameters };
  for (const endpoint of endpoints.slice(1)) for (const name of Object.keys(common) as Array<keyof ImageParameterDefinitions>) {
    const left = common[name], right = endpoint.image.parameters?.[name];
    if (!left || !right || left.type !== right.type) { delete common[name]; continue; }
    if (left.type === "enum" && right.type === "enum") {
      const values = left.values.filter((value) => right.values.includes(value));
      if (values.length) common[name] = { type: "enum", values }; else delete common[name];
    } else if (left.type === "range" && right.type === "range") {
      const min = Math.max(left.min, right.min), max = Math.min(left.max, right.max);
      if (min <= max) common[name] = { type: "range", min, max }; else delete common[name];
    }
  }
  return common;
}

export function ImageModelFields({ connection, credential, form, disabled, discoverOnMount = true, onChange }: {
  connection: AdminProviderConnection; credential: AdminProviderCredential | null;
  form: ModelForm; disabled: boolean; discoverOnMount?: boolean; onChange(form: ModelForm): void;
}) {
  const [requested, setRequested] = useState(discoverOnMount);
  const [catalogState, setCatalogState] = useState<{ key: string; models: AdminImageDiscoveredModel[]; error: string | null } | null>(null);
  const [endpointState, setEndpointState] = useState<{ key: string; endpoints: AdminImageDiscoveredEndpoint[] } | null>(null);
  const [revision, setRevision] = useState(0);
  const credentialId = credential?.id;
  const identity = `${connection.id}:${connection.draftVersion}:${connection.activeVersion}:${credentialId}:${credential?.draftVersion}:${credential?.activeVersion?.id}`;
  const catalogKey = `${identity}:${revision}`;
  const endpointKey = `${identity}:${form.upstreamModelId}`;
  const catalog = catalogState?.key === catalogKey ? catalogState.models : [];
  const endpoints = endpointState?.key === endpointKey ? endpointState.endpoints : [];
  const loading = requested && Boolean(credentialId) && catalogState?.key !== catalogKey;
  const error = catalogState?.key === catalogKey ? catalogState.error : null;
  useEffect(() => {
    let current = true;
    if (!requested || !credentialId) return;
    void discoverAdminImageModels(connection.id, credentialId).then((result) => {
      if (!current) return;
      setCatalogState({ key: catalogKey, models: result.ok ? result.data : [], error: result.ok ? null : "Image models could not be loaded. Check the provider key and try again." });
    });
    return () => { current = false; };
  }, [connection.id, credentialId, catalogKey, requested]);
  useEffect(() => {
    let current = true;
    if (!requested || connection.family !== "openrouter" || !credentialId || !form.upstreamModelId) return;
    void discoverAdminImageEndpoints(connection.id, credentialId, form.upstreamModelId).then((result) => {
      if (current) setEndpointState({ key: endpointKey, endpoints: result.ok ? result.data : [] });
    });
    return () => { current = false; };
  }, [connection.family, connection.id, credentialId, form.upstreamModelId, endpointKey, requested]);
  const parameters = useMemo(() => {
    try { return JSON.parse(form.defaultParamsText) as ImageGenerationParameters; } catch { return {}; }
  }, [form.defaultParamsText]);
  const selected = catalog.find((entry) => entry.id === form.upstreamModelId);
  return <div className="flex min-w-0 flex-col gap-4">
    <AdminSearchablePicker label="Image model" items={catalog.map((entry) => ({ id: entry.id, label: entry.name,
      secondaryText: `${entry.id}${entry.source === "preset" ? " · requires a capability check" : ""}` }))}
      disabled={disabled || !credentialId} loading={loading} error={error} onRetry={() => setRevision((value) => value + 1)}
      onOpenChange={(open) => { if (open) setRequested(true); }}
      placeholder="Choose an image model" searchPlaceholder="Search image models" noun={{ singular: "model", plural: "models" }}
      emptyTitle="No image models reported" emptyDescription="For a compatible provider, enter the image model id below."
      selectedId={form.upstreamModelId || null} selectedFallbackLabel={form.displayName || form.upstreamModelId}
      onSelect={({ id }) => {
        const entry = catalog.find((candidate) => candidate.id === id);
        if (!entry) return;
        const configuration = imageModelConfiguration(entry.id, entry.image);
        onChange({ ...form, ...configuration, capabilities: { ...configuration.capabilities, imageEditing: entry.editing },
          image: entry.image, displayName: entry.name, defaultParamsText: "{}", openRouterRoutingMode: "automatic", providerTags: [] });
      }} />
    {connection.family === "openai_compatible" ? <>
      <label><span className="mb-1 block text-xs font-medium text-ink-secondary">Upstream image model id</span>
        <input className={inputClass} disabled={disabled} value={form.upstreamModelId} maxLength={256}
          onChange={(event) => onChange({ ...form, upstreamModelId: event.currentTarget.value, defaultParamsText: "{}" })} /></label>
      <label><span className="mb-1 block text-xs font-medium text-ink-secondary">Image API</span>
        <select className={inputClass} disabled={disabled} value={form.image?.profile ?? "openai_compatible"}
          onChange={(event) => onChange({ ...form, image: { profile: event.currentTarget.value === "codex_lb" ? "codex_lb" : "openai_compatible" }, defaultParamsText: "{}" })}>
          <option value="openai_compatible">OpenAI compatible Images</option><option value="codex_lb">codex-lb</option>
        </select></label>
    </> : null}
    {connection.family === "openrouter" ? <fieldset className="min-w-0" onFocus={() => setRequested(true)}>
      <legend className="mb-1 text-xs font-medium text-ink-secondary">Image providers</legend>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={disabled} checked={form.openRouterRoutingMode === "automatic"}
        onChange={(event) => onChange({ ...form, openRouterRoutingMode: event.currentTarget.checked ? "automatic" : "only_selected",
          providerTags: [], image: selected?.image ?? form.image, defaultParamsText: "{}" })} />Automatic routing</label>
      {form.openRouterRoutingMode === "only_selected" ? <div className="mt-2 flex flex-col gap-2">
        {endpoints.map((endpoint) => <label className="flex items-center gap-2 text-sm" key={endpoint.tag}>
          <input type="checkbox" disabled={disabled} checked={form.providerTags.includes(endpoint.tag)} onChange={(event) => {
            const tags = event.currentTarget.checked ? [...form.providerTags, endpoint.tag] : form.providerTags.filter((tag) => tag !== endpoint.tag);
            onChange({ ...form, providerTags: tags, image: { profile: "openrouter", parameters: sharedParameters(endpoints.filter((item) => tags.includes(item.tag))) }, defaultParamsText: "{}" });
          }} />{endpoint.name}
        </label>)}
        {!endpoints.length ? <p className="text-xs text-ink-muted">No selectable image providers were reported.</p> : null}
      </div> : null}
    </fieldset> : null}
    {form.image && form.upstreamModelId ? <ImageParameterFields image={form.image} modelId={form.upstreamModelId} parameters={parameters}
      disabled={disabled} onChange={(value) => onChange({ ...form, defaultParamsText: JSON.stringify(value, null, 2) })} /> : null}
    <p className="text-xs leading-5 text-ink-muted">Test &amp; Save checks image generation and editing separately. Select the chat image model in Defaults &amp; roles.</p>
  </div>;
}
