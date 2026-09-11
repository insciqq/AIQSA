"use client";

import { useRef, useState } from "react";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import { UiV2Button } from "@/components/ui-v2";

export function AdminProviderCatalogModels({ connection, controller }: Readonly<{
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
}>) {
  const [selection, setSelection] = useState<readonly string[] | null>(null);
  const [unavailable, setUnavailable] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const catalog = connection.catalogUpdates;
  const available = catalog?.available ?? [];
  const selected = new Set(selection ?? available.map(({ id }) => id));
  const selectedIds = available.filter(({ id }) => selected.has(id)).map(({ id }) => id);
  const credential = connection.credentials.find(({ id }) => id === connection.defaultCredentialId);
  const keyReady = connection.enabled && credential?.enabled && credential.activeVersion && credential.activeVersion.revokedAt === null;
  const busy = controller.state.busy;

  async function add() {
    if (pending.current || busy || !keyReady || !credential?.activeVersion || !selectedIds.length) return;
    pending.current = true;
    setError(null);
    try {
      const result = await controller.actions.addCatalogModels(connection.id, {
        credentialId: credential.id, expectedConnectionVersion: connection.activeVersion,
        expectedCredentialVersionId: credential.activeVersion.id, modelIds: selectedIds
      });
      if (!result.ok) { setError(result.message); return; }
      setUnavailable(result.unavailableModelIds);
      setSelection(result.unavailableModelIds);
    } finally { pending.current = false; }
  }

  async function skip(modelIds: readonly string[], restore = false) {
    if (pending.current || busy || !modelIds.length) return;
    pending.current = true;
    setError(null);
    try {
      const success = await controller.actions.connectionAction(connection.id, {
        action: restore ? "restore_catalog_models" : "skip_catalog_models",
        expectedConnectionVersion: connection.activeVersion, modelIds
      }, restore ? "Models returned to the selection." : "Selected catalog models skipped.", { quiet: true });
      if (!success) { setError("Could not update these suggestions. Your selection is kept; refresh and try again."); return; }
      setSelection(restore ? [...selected, ...modelIds] : [...selected].filter((id) => !modelIds.includes(id)));
      setUnavailable((previous) => previous.filter((id) => !modelIds.includes(id)));
    } finally { pending.current = false; }
  }

  if (!connection.activeConfig || connection.activeVersion < 1) return null;
  return (
    <section aria-labelledby="provider-catalog-heading" className="flex min-w-0 flex-col gap-3 rounded-xl border border-trace-subtle bg-answer-paper p-4 sm:p-5" data-testid="provider-catalog-models">
      <div>
        <h3 className="text-sm font-semibold text-ink" id="provider-catalog-heading">New models in the AIQSA catalog</h3>
        <p className="mt-1 text-xs leading-5 text-ink-muted">Choose models to add. Availability and capabilities are checked with your key.</p>
      </div>
      {!catalog ? <p className="text-xs text-caution" role="status">Catalog suggestions are unavailable. Refresh this provider to try again.</p> : null}
      {catalog && !available.length ? <p className="text-xs text-ink-muted">No new models to add.</p> : null}
      {available.length ? <>
        <p className="text-xs text-ink-secondary">Key: <span className="font-medium">{credential?.label ?? "No default key"}</span>{!keyReady ? ". Enable this connection and save a working default key in Keys below." : ""}</p>
        <div className="divide-y divide-trace-subtle rounded-lg border border-trace-subtle">
          {available.map((model) => <label className="grid min-h-touch grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-3 py-2" key={model.id}>
            <input checked={selected.has(model.id)} className="size-4 accent-proof" disabled={busy}
              onChange={(event) => setSelection(event.currentTarget.checked ? [...selected, model.id] : [...selected].filter((id) => id !== model.id))} type="checkbox" />
            <span className="min-w-0">
              <span className="block break-words text-sm text-ink">{model.displayName}</span>
              <span className="block break-all font-mono text-xs text-ink-muted">{model.upstreamModelId}</span>
              {unavailable.includes(model.id) ? <span className="block text-xs text-caution">Not available in this key&apos;s catalog; not added.</span> : null}
            </span>
          </label>)}
        </div>
        <div className="flex flex-wrap gap-2">
          <UiV2Button disabled={busy || !keyReady || !selectedIds.length || connection.checkRun?.state === "running"} onClick={() => void add()} type="button">Add &amp; check selected</UiV2Button>
          <UiV2Button disabled={busy || !selectedIds.length} onClick={() => void skip(selectedIds)} tone="ghost" type="button">Skip selected</UiV2Button>
        </div>
        {connection.checkRun?.state === "running" ? <p className="text-xs text-ink-muted" role="status">Checks are running. Progress and each model&apos;s results appear in Models below.</p> : null}
      </> : null}
      {catalog?.skipped.length ? <details>
        <summary className="min-h-touch cursor-pointer py-2 text-sm text-ink-secondary">Skipped models ({catalog.skipped.length})</summary>
        <ul className="divide-y divide-trace-subtle">
          {catalog.skipped.map((model) => <li className="flex min-w-0 flex-wrap items-center gap-3 py-2" key={model.id}>
            <div className="min-w-0 flex-1"><p className="break-words text-sm text-ink">{model.displayName}</p><p className="break-all font-mono text-xs text-ink-muted">{model.upstreamModelId}</p></div>
            <UiV2Button aria-label={`Restore ${model.displayName}`} disabled={busy} onClick={() => void skip([model.id], true)} tone="ghost" type="button">Restore</UiV2Button>
          </li>)}
        </ul>
      </details> : null}
      {error ? <p className="text-xs text-critical" role="alert">{error}</p> : null}
    </section>
  );
}
