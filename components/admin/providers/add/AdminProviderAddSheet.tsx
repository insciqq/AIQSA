"use client";

import { AdminProviderSetupProgress } from "./AdminProviderSetupProgress";
import { AdminProviderSetupResults } from "./AdminProviderSetupResults";
import { adminProviderErrorMessage, getAdminProviderCheckRun, getAdminProviderConnections, runAdminProviderConnectionAction } from "@/components/admin/adminProvidersApi";
import type { AdminProviderSetupProgress as SetupProgress } from "@/lib/contracts/adminProviderSetupProgress";
import { inputClass } from "@/components/admin/adminPrimitives";
import {
  adminProviderCustomSetupErrorMessage,
  discoverAdminProviderCustomModels,
  submitAdminProviderCustomSetup
} from "@/components/admin/adminProviderCustomSetupApi";
import {
  adminProviderQuickSetupErrorMessage,
  getAdminProviderQuickSetup,
  submitAdminProviderQuickSetup,
  type AdminProviderQuickSetupSelectionResult,
  type AdminProviderQuickSetupSnapshot
} from "@/components/admin/adminProviderQuickSetupApi";
import {
  reasoningCapabilitiesSummary,
  reasoningForChoice,
  type AdminProviderReasoningChoice
} from "@/components/admin/adminProviderReasoning";
import { AdminSheet } from "@/components/admin/AdminSheet";
import {
  ADD_PROVIDER_TILES,
  builtInRequest,
  customDiscoveryRequest,
  customNameFor,
  customRequest,
  customSaveLabel,
  discoveredModelHint,
  familyConnections,
  initialBuiltInForm,
  initialCustomForm,
  type AddProviderFamily,
  type BuiltInForm,
  type CustomForm
} from "@/components/admin/providers/add/addProviderView";
import { providerFamilyLabel } from "@/components/admin/providers/providerListView";
import { ProviderAvatar } from "@/components/admin/providers/providerPrimitives";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import type { AdminProviderCustomDiscoveredModel } from "@/lib/contracts/adminProviderCustomSetup";
import type { AdminProviderQuickSetupProviderId } from "@/lib/contracts/adminProviderQuickSetup";
import {
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS,
  type AdminProviderConnection,
  type AdminProviderCheckRun
} from "@/lib/contracts/adminProviders";
import { compatibleReasoningRequestMappingDefault } from "@/lib/contracts/providerReasoningRequestMapping";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";
const helpText = "mt-1 block text-xs leading-5 text-ink-muted";
const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper";
const tileBase =
  `flex min-h-[3.25rem] min-w-0 items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition-colors ${focusRing} disabled:cursor-not-allowed disabled:opacity-60`;
const tileIdle = "border-trace-strong bg-answer-paper hover:bg-control-hover";
const tileActive = "border-proof bg-proof/10";

type SnapshotState =
  | Readonly<{ error: string; kind: "error" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; snapshot: AdminProviderQuickSetupSnapshot }>;

type DiscoveryState = Readonly<{
  attempted: boolean;
  error: string | null;
  loading: boolean;
  models: readonly AdminProviderCustomDiscoveredModel[] | null;
}>;

type FormError = Readonly<{ field: string | null; message: string }>;
type SavedSetup = Readonly<{
  connectionId: string;
  credentialId: string;
  run: AdminProviderCheckRun | null;
  models: ReadonlyArray<{ id: string; displayName: string }>;
}>;

export type AdminProviderAddSheetProps = Readonly<{
  connections: readonly AdminProviderConnection[];
  onClose(): void;
  /** The connection now exists on the server; the caller opens its page. */
  onCreated(connectionId: string): void;
  open: boolean;
}>;

function ProviderTiles({
  disabled,
  onSelect,
  selected
}: Readonly<{ disabled: boolean; onSelect(family: AddProviderFamily): void; selected: AddProviderFamily }>) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="provider-add-tiles" role="group" aria-label="Provider">
      {ADD_PROVIDER_TILES.map((tile) => {
        const active = tile.family === selected;
        return (
          <button
            aria-pressed={active}
            className={`${tileBase} ${active ? tileActive : tileIdle} ${tile.family === "custom" ? "border-dashed" : ""}`}
            data-testid={`provider-add-tile-${tile.family}`}
            disabled={disabled}
            key={tile.family}
            onClick={() => onSelect(tile.family)}
            type="button"
          >
            <ProviderAvatar family={tile.family === "custom" ? "openai_compatible" : tile.family} label={tile.label} />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold text-ink">{tile.label}</span>
              {tile.subtitle ? <span className="block text-metadata text-ink-muted">{tile.subtitle}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AdvancedDetails({ children, summary }: Readonly<{ children: ReactNode; summary: string }>) {
  return (
    <details className="group rounded-[10px] border border-trace-subtle bg-control-surface/45 px-3">
      <summary className={`flex min-h-touch cursor-pointer list-none items-center gap-2 py-2.5 text-[13px] text-ink-secondary ${focusRing}`}>
        <UiV2Icon className="size-3.5 shrink-0 text-ink-muted transition-transform group-open:rotate-90" name="chevron-right" />
        <span>{summary}</span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-trace-subtle py-4">{children}</div>
    </details>
  );
}

/** A labelled control whose label text stays exact (help copy lives outside the label). */
function Field({
  className = "",
  help,
  label,
  render
}: Readonly<{ className?: string; help?: ReactNode; label: string; render(id: string): ReactNode }>) {
  const id = useId();
  return (
    <div className={`min-w-0 ${className}`.trim()}>
      <label className={fieldLabel} htmlFor={id}>{label}</label>
      {render(id)}
      {help ? <span className={helpText}>{help}</span> : null}
    </div>
  );
}

function TimeoutField({
  disabled,
  invalid,
  onChange,
  value
}: Readonly<{ disabled: boolean; invalid: boolean; onChange(value: string): void; value: string }>) {
  return (
    <Field
      className="sm:max-w-xs"
      help={`How long one answer may take, from ${ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS} to ${ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS} seconds.`}
      label="Response timeout (seconds)"
      render={(id) => (
        <input
          aria-invalid={invalid || undefined}
          className={inputClass}
          disabled={disabled}
          id={id}
          max={ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS}
          min={ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS}
          onChange={(event) => onChange(event.currentTarget.value)}
          step={1}
          type="number"
          value={value}
        />
      )}
    />
  );
}

function PrivateNetworkField({
  checked,
  disabled,
  onChange
}: Readonly<{ checked: boolean; disabled: boolean; onChange(next: boolean): void }>) {
  return (
    <label className="flex items-start gap-3 text-sm text-ink">
      <input
        checked={checked}
        className="mt-1 size-4 shrink-0 accent-proof"
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span>
        Private network
        <span className={helpText}>Allow a local or private endpoint. Keep this off for public providers.</span>
      </span>
    </label>
  );
}

function AddSheetBody({ connections, onClose, onCreated }: Omit<AdminProviderAddSheetProps, "open">) {
  const [family, setFamily] = useState<AddProviderFamily>("openai");
  const [builtIn, setBuiltIn] = useState<BuiltInForm>(() => initialBuiltInForm("openai", connections));
  const [custom, setCustom] = useState<CustomForm>(initialCustomForm);
  const [customNameTouched, setCustomNameTouched] = useState(false);
  const [reasoningPathsTouched, setReasoningPathsTouched] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryState>({ attempted: false, error: null, loading: false, models: null });
  const [snapshotState, setSnapshotState] = useState<SnapshotState>({ kind: "loading" });
  const [snapshotGeneration, setSnapshotGeneration] = useState(0);
  const [selection, setSelection] = useState<AdminProviderQuickSetupSelectionResult | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const [savedSetup, setSavedSetup] = useState<SavedSetup | null>(null);
  const [error, setError] = useState<FormError | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const progressRef = useRef<SetupProgress | null>(null);
  const formId = useId();
  const errorId = useId();
  const busy = submitting || discovery.loading || savedSetup?.run?.state === "running";
  const savedConnectionId = savedSetup?.connectionId;
  const savedRunId = savedSetup?.run?.id;
  const savedRunState = savedSetup?.run?.state;

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!savedConnectionId || !savedRunId || savedRunState !== "running") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connectionId = savedConnectionId;
    const runId = savedRunId;
    const poll = async () => {
      const result = await getAdminProviderCheckRun(connectionId, runId);
      if (disposed) return;
      if (!result.ok) {
        setError({ field: null, message: "Could not refresh check progress. Saved models are kept; open the provider to review them." });
        timer = setTimeout(() => void poll(), 2_000);
        return;
      }
      setError(null);
      setSavedSetup((current) => current?.run?.id === runId ? { ...current, run: result.data } : current);
      if (result.data.state === "running") timer = setTimeout(() => void poll(), 1_200);
      else {
        const catalog = await getAdminProviderConnections();
        if (catalog.ok) setSavedSetup((current) => current?.run?.id === runId
          ? { ...current, models: catalog.data.find((connection) => connection.id === connectionId)?.models ?? current.models }
          : current);
      }
    };
    timer = setTimeout(() => void poll(), 1_200);
    return () => { disposed = true; clearTimeout(timer); };
  }, [savedConnectionId, savedRunId, savedRunState]);

  useEffect(() => {
    const abort = new AbortController();
    void getAdminProviderQuickSetup(fetch, abort.signal).then((result) => {
      if (abort.signal.aborted) return;
      setSnapshotState(result.ok
        ? { kind: "ready", snapshot: result.data }
        : { error: adminProviderQuickSetupErrorMessage(result.error), kind: "error" });
    });
    return () => abort.abort();
  }, [snapshotGeneration]);

  const builtInFamily = family === "custom" ? null : family;
  const existing = builtInFamily ? familyConnections(connections, builtInFamily) : [];
  const provider = snapshotState.kind === "ready" && builtInFamily
    ? snapshotState.snapshot.providers.find((entry) => entry.provider === builtInFamily) ?? null
    : null;
  const dirty = (builtInFamily !== null &&
      JSON.stringify(builtIn) !== JSON.stringify(initialBuiltInForm(builtInFamily, connections))) ||
    JSON.stringify(custom) !== JSON.stringify(initialCustomForm()) ||
    discovery.attempted;

  const selectFamily = (next: AddProviderFamily) => {
    if (next === family || busy) return;
    setFamily(next);
    setError(null);
    setSelection(null);
    setSelectedCandidateId(null);
    if (next !== "custom") {
      // Keep a pasted key; the name and endpoint follow the family.
      setBuiltIn((current) => ({ ...initialBuiltInForm(next, connections), secret: current.secret }));
    }
  };

  const updateBuiltIn = (patch: Partial<BuiltInForm>) => {
    setBuiltIn((current) => ({ ...current, ...patch }));
    setError(null);
    if ("secret" in patch) {
      setSelection(null);
      setSelectedCandidateId(null);
    }
  };

  const updateCustom = (patch: Partial<CustomForm>) => {
    setCustom((current) => {
      const next = { ...current, ...patch };
      const endpointChanged = "apiRoot" in patch || "secret" in patch || "noKey" in patch || "allowPrivateNetwork" in patch;
      return {
        ...next,
        ...(patch.noKey ? { allowPrivateNetwork: true, secret: "" } : {}),
        ...(!customNameTouched && "apiRoot" in patch ? { name: customNameFor(next.apiRoot) } : {}),
        ...(!reasoningPathsTouched && "protocol" in patch
          ? {
              reasoningEffortPath: compatibleReasoningRequestMappingDefault(next.protocol).effortPath,
              reasoningModePath: compatibleReasoningRequestMappingDefault(next.protocol).modePath ?? ""
            }
          : {}),
        ...(endpointChanged ? { selectedModelIds: [] } : {})
      };
    });
    setError(null);
    if ("apiRoot" in patch || "secret" in patch || "noKey" in patch || "allowPrivateNetwork" in patch) {
      setDiscovery((current) => ({ ...current, error: null, models: null }));
    }
  };

  const refreshSavedSetup = async (base: SavedSetup, runId?: string) => {
    setSavedSetup(base);
    const [catalog, checked] = await Promise.all([
      getAdminProviderConnections(),
      runId ? getAdminProviderCheckRun(base.connectionId, runId) : Promise.resolve(null)
    ]);
    const connection = catalog.ok ? catalog.data.find(({ id }) => id === base.connectionId) : null;
    setSavedSetup((current) => current?.connectionId === base.connectionId && current.run?.id === base.run?.id ? {
      ...current,
      models: connection?.models ?? current.models,
      run: checked?.ok ? checked.data : connection?.checkRun ?? current.run,
      credentialId: current.credentialId || connection?.defaultCredentialId || ""
    } : current);
  };

  const showInterruptedSetup = async (message: string) => {
    setSubmitting(false);
    setProgress(null);
    setInterrupted(true);
    setError({ field: null, message });
    const saved = progressRef.current;
    if (saved?.connectionId) await refreshSavedSetup({
      connectionId: saved.connectionId, credentialId: saved.credentialId ?? "", models: [], run: null
    }, saved.runId);
  };

  const stopSetup = async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (discovery.loading && !submitting) {
      setDiscovery((current) => ({ ...current, loading: false, error: "Model discovery stopped. You can try again." }));
      return;
    }
    setDiscovery((current) => ({ ...current, loading: false }));
    if (savedSetup?.run?.state === "running") {
      setSubmitting(true);
      const result = await runAdminProviderConnectionAction(savedSetup.connectionId, { action: "cancel_check", runId: savedSetup.run.id });
      setSubmitting(false);
      if (!result.ok) setError({ field: null, message: adminProviderErrorMessage(result.error) });
      await refreshSavedSetup(savedSetup, savedSetup.run.id);
      return;
    }
    await showInterruptedSetup(progressRef.current?.connectionId
      ? "Checking stopped. Saved models are kept; unfinished checks can be retried."
      : "Setup stopped before its saved state was received. Close this sheet and check the provider list before trying again.");
  };

  const retrySetup = async () => {
    if (!savedSetup || !savedSetup.credentialId || busy) return;
    setSubmitting(true);
    setError(null);
    const result = await runAdminProviderConnectionAction(savedSetup.connectionId, {
      action: "check_models", credentialId: savedSetup.credentialId, retryUnresolved: true
    });
    setSubmitting(false);
    if (!result.ok) { setError({ field: null, message: adminProviderErrorMessage(result.error) }); return; }
    const connection = result.data.find(({ id }) => id === savedSetup.connectionId);
    setSavedSetup({ ...savedSetup, models: connection?.models ?? savedSetup.models, run: connection?.checkRun ?? null });
  };

  const finishSetup = async (result: { connectionId: string; outcome: "ready" | "partial" | "cancelled"; checkRun?: AdminProviderCheckRun }) => {
    if (result.outcome === "ready") { onCreated(result.connectionId); return; }
    setSubmitting(false);
    setProgress(null);
    setInterrupted(true);
    await refreshSavedSetup({ connectionId: result.connectionId, credentialId: result.checkRun?.credentialId ?? "", models: [], run: result.checkRun ?? null });
  };

  const requestClose = () => {
    if (busy) return;
    if (interrupted) { onClose(); return; }
    if (dirty) {
      setDiscarding(true);
      return;
    }
    onClose();
  };

  const discover = async () => {
    const body = customDiscoveryRequest(custom);
    if (!body) {
      setError({
        field: "apiRoot",
        message: custom.noKey
          ? "An endpoint without a key must be a private http:// address with Private network on."
          : "Enter the base URL and the API key first."
      });
      return;
    }
    const abort = new AbortController();
    abortRef.current?.abort();
    abortRef.current = abort;
    setError(null);
    setDiscovery({ attempted: true, error: null, loading: true, models: null });
    const result = await discoverAdminProviderCustomModels(body, fetch, abort.signal);
    if (abort.signal.aborted) return;
    abortRef.current = null;
    if (!result.ok) {
      setDiscovery({ attempted: true, error: adminProviderCustomSetupErrorMessage(result.error), loading: false, models: null });
      return;
    }
    const models = result.data.models;
    setDiscovery({ attempted: true, error: null, loading: false, models });
    const supported = models.filter((model) => discoveredModelHint(model).supported);
    setCustom((current) => ({
      ...current,
      selectedModelIds: supported.length === 1 ? [supported[0]!.id] : []
    }));
  };

  const submitBuiltIn = async () => {
    if (!builtInFamily || !provider) return;
    const chosen = selection && selectedCandidateId
      ? { candidateId: selectedCandidateId, policyVersion: selection.policyVersion }
      : undefined;
    if (selection && !chosen) {
      setError({ field: "selection", message: "Choose a model available to this key." });
      return;
    }
    const validation = builtInRequest({
      connections,
      expectedState: selection?.expectedState ?? provider.stateToken,
      family: builtInFamily,
      form: builtIn,
      ...(chosen ? { selectedModel: chosen } : {})
    });
    if (!validation.ok) {
      setError({ field: validation.field, message: validation.message });
      return;
    }
    const abort = new AbortController();
    abortRef.current?.abort();
    abortRef.current = abort;
    setSubmitting(true);
    progressRef.current = { phase: "validating", completed: 0, total: null };
    setProgress(progressRef.current);
    setError(null);
    const result = await submitAdminProviderQuickSetup(validation.body, fetch, abort.signal, (value) => {
      if (abortRef.current === abort && !abort.signal.aborted) {
        progressRef.current = { ...progressRef.current, ...value };
        setProgress(progressRef.current);
      }
    });
    if (abort.signal.aborted) return;
    abortRef.current = null;
    if (!result.ok) {
      setSubmitting(false);
      setProgress(null);
      if (progressRef.current?.connectionId) {
        await showInterruptedSetup(adminProviderQuickSetupErrorMessage(result.error));
        return;
      }
      if (["network_error", "provider_setup_interrupted"].includes(result.error.code) || result.error.code.endsWith("response_invalid")) {
        await showInterruptedSetup("The setup connection was interrupted. Saved results are kept; review them before continuing.");
        return;
      }
      setError({
        field: result.error.code === "provider_credential_test_failed" ? "secret" : null,
        message: adminProviderQuickSetupErrorMessage(result.error)
      });
      if (result.error.code === "provider_draft_stale") {
        setSelection(null);
        setSelectedCandidateId(null);
        setSnapshotState({ kind: "loading" });
        setSnapshotGeneration((value) => value + 1);
      }
      return;
    }
    if (result.data.outcome === "selection_required") {
      setSubmitting(false);
      setProgress(null);
      setSelection(result.data);
      setSelectedCandidateId(null);
      return;
    }
    await finishSetup(result.data);
  };

  const submitCustom = async () => {
    const validation = customRequest({ connections, discovered: discovery.models, form: custom });
    if (!validation.ok) {
      setError({ field: validation.field, message: validation.message });
      return;
    }
    const abort = new AbortController();
    abortRef.current?.abort();
    abortRef.current = abort;
    setSubmitting(true);
    progressRef.current = { phase: "validating", completed: 0, total: null };
    setProgress(progressRef.current);
    setError(null);
    const result = await submitAdminProviderCustomSetup(validation.body, fetch, abort.signal, (value) => {
      if (abortRef.current === abort && !abort.signal.aborted) {
        progressRef.current = { ...progressRef.current, ...value };
        setProgress(progressRef.current);
      }
    });
    if (abort.signal.aborted) return;
    abortRef.current = null;
    if (!result.ok) {
      setSubmitting(false);
      setProgress(null);
      if (progressRef.current?.connectionId) {
        await showInterruptedSetup(adminProviderCustomSetupErrorMessage(result.error));
        return;
      }
      if (["network_error", "provider_setup_interrupted"].includes(result.error.code) || result.error.code.endsWith("response_invalid")) {
        await showInterruptedSetup("The setup connection was interrupted. Saved results are kept; review them before continuing.");
        return;
      }
      setError({
        field: result.error.code === "provider_custom_setup_test_failed" ? "secret" : null,
        message: adminProviderCustomSetupErrorMessage(result.error)
      });
      return;
    }
    await finishSetup(result.data);
  };

  const customModelCount = discovery.models?.length
    ? custom.selectedModelIds.length
    : custom.manualModelId.trim()
      ? 1
      : 0;
  const saveLabel = family === "custom" ? customSaveLabel(customModelCount) : "Test & Save";
  const canSave = family === "custom"
    ? customModelCount > 0
    : provider !== null && (!selection || selectedCandidateId !== null);
  const selectedReasoning = custom.reasoningChoice === "automatic"
    ? { reasoning: (discovery.models ?? []).some((model) =>
      custom.selectedModelIds.includes(model.id) && model.capabilities.reasoning === true) }
    : reasoningForChoice(custom.reasoningChoice, []);
  const unfinished = !savedSetup?.run || savedSetup.run.state !== "completed" ||
    savedSetup.run.failed.length > 0 || Boolean(savedSetup.run.skipped?.length) || savedSetup.run.setup?.state === "partial" ||
    Boolean(savedSetup.run.results?.some((result) => result.state !== "saved"));
  const fieldsLocked = busy || interrupted || Boolean(savedSetup);

  return (
    <AdminSheet
      closeBlocked={busy}
      footer={(
        <>
          {savedSetup ? unfinished ? <UiV2Button busy={submitting} disabled={busy || !savedSetup.credentialId} onClick={() => void retrySetup()} tone="primary" type="button">Retry unfinished checks</UiV2Button> : null : <UiV2Button busy={submitting} disabled={busy || interrupted || !canSave} form={formId} tone="primary" type="submit">
            {saveLabel}
          </UiV2Button>}
          <UiV2Button disabled={Boolean(savedSetup) && submitting} onClick={busy ? () => void stopSetup() : savedSetup ? () => onCreated(savedSetup.connectionId) : requestClose} tone={savedSetup && !unfinished ? "primary" : "ghost"} type="button">{busy ? "Stop" : savedSetup ? "View provider" : interrupted ? "Close and review providers" : "Cancel"}</UiV2Button>
          <span className="min-w-0 text-xs leading-5 text-ink-muted sm:ml-auto sm:text-right">
            Checks supported models and Search, then fills empty roles, including Knowledge. Assigned PDF readers receive page images and text. Uses small paid requests.
          </span>
        </>
      )}
      onClose={requestClose}
      open
      testId="provider-add-sheet"
      title="Add provider"
      width="wide"
    >
      <form
        aria-describedby={error ? errorId : undefined}
        className="flex flex-col gap-5"
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || interrupted) return;
          void (family === "custom" ? submitCustom() : submitBuiltIn());
        }}
      >
        <div>
          <span className={fieldLabel}>Provider</span>
          <ProviderTiles disabled={fieldsLocked} onSelect={selectFamily} selected={family} />
          {builtInFamily && existing.length > 0 ? (
            <p className={helpText} data-testid="provider-add-second-hint">
              {providerFamilyLabel(builtInFamily)} is already connected. This adds a second {providerFamilyLabel(builtInFamily)} connection, for example for another account.
            </p>
          ) : null}
        </div>

        {builtInFamily ? (
          <BuiltInFields
            busy={fieldsLocked}
            error={error}
            family={builtInFamily}
            form={builtIn}
            nameRequired={existing.length > 0}
            onRetrySnapshot={() => {
              setSnapshotState({ kind: "loading" });
              setSnapshotGeneration((value) => value + 1);
            }}
            onSelectCandidate={(candidateId) => {
              setSelectedCandidateId(candidateId);
              setError(null);
            }}
            provider={provider}
            selectedCandidateId={selectedCandidateId}
            selection={selection}
            snapshotState={snapshotState}
            update={updateBuiltIn}
          />
        ) : (
          <CustomFields
            busy={fieldsLocked}
            discovery={discovery}
            error={error}
            form={custom}
            onDiscover={() => void discover()}
            onNameTouched={() => setCustomNameTouched(true)}
            onReasoningPathsTouched={() => setReasoningPathsTouched(true)}
            selectedReasoning={selectedReasoning}
            update={updateCustom}
          />
        )}

        {submitting && progress ? <AdminProviderSetupProgress progress={progress} /> : discovery.loading
          ? <AdminProviderSetupProgress progress={{ phase: "discovering", completed: 0, total: null }} /> : null}
        {savedSetup ? <section aria-label="Saved setup" className="min-w-0 rounded-[10px] border border-trace-subtle px-4 py-3">
          <h3 className="text-sm font-medium text-ink">{savedSetup.run?.state === "running" ? "Checking unfinished work…"
            : savedSetup.run?.state === "cancelled" ? "Setup stopped"
            : unfinished ? "Some setup steps need attention" : "Setup finished"}</h3>
          <p className="mt-1 text-xs leading-5 text-ink-muted">Saved models are kept. Retry uses their current successful checks and completes only unfinished work.</p>
          {savedSetup.run?.state === "running" ? <AdminProviderSetupProgress progress={{
            phase: savedSetup.run.setup?.state === "running" ? "finishing" : "checking",
            completed: savedSetup.run.done, total: savedSetup.run.total || null,
            ...(savedSetup.run.capabilityProgress ? { capability: savedSetup.run.capabilityProgress.capability } : {})
          }} /> : null}
          {savedSetup.run ? <AdminProviderSetupResults models={savedSetup.models} run={savedSetup.run} /> : null}
        </section> : null}

        {error ? (
          <p className="text-xs leading-5 text-critical" data-testid="provider-add-error" id={errorId} role="alert">
            {error.message}
          </p>
        ) : null}
      </form>
      {discarding ? (
        <ConfirmationDialog
          confirmLabel="Discard changes"
          dialogLabel="Discard unsaved provider"
          icon="x"
          onCancel={() => setDiscarding(false)}
          onConfirm={() => {
            setDiscarding(false);
            onClose();
          }}
          testId="provider-add-discard"
          title="Discard unsaved changes?"
          tone="warning"
        >
          The provider has not been added yet; what you typed will be lost.
        </ConfirmationDialog>
      ) : null}
    </AdminSheet>
  );
}

function BuiltInFields({
  busy,
  error,
  family,
  form,
  nameRequired,
  onRetrySnapshot,
  onSelectCandidate,
  provider,
  selectedCandidateId,
  selection,
  snapshotState,
  update
}: Readonly<{
  busy: boolean;
  error: FormError | null;
  family: AdminProviderQuickSetupProviderId;
  form: BuiltInForm;
  nameRequired: boolean;
  onRetrySnapshot(): void;
  onSelectCandidate(candidateId: string): void;
  provider: AdminProviderQuickSetupSnapshot["providers"][number] | null;
  selectedCandidateId: string | null;
  selection: AdminProviderQuickSetupSelectionResult | null;
  snapshotState: SnapshotState;
  update(patch: Partial<BuiltInForm>): void;
}>) {
  const label = providerFamilyLabel(family);
  const candidateNames = provider?.candidateModels.map(({ displayName }) => displayName).join(", ") ?? null;
  return (
    <>
      <Field
        help={nameRequired ? "A distinct name tells the connections apart in lists and pickers." : undefined}
        label="Name"
        render={(id) => (
          <input
            aria-invalid={error?.field === "name" || undefined}
            className={inputClass}
            disabled={busy}
            id={id}
            maxLength={160}
            onChange={(event) => update({ name: event.currentTarget.value })}
            required={nameRequired}
            value={form.name}
          />
        )}
      />
      <Field
        help="Write-only. Stored encrypted and never shown again."
        label="API key"
        render={(id) => (
          <input
            aria-invalid={error?.field === "secret" || undefined}
            autoComplete="off"
            autoCapitalize="none"
            className={`${inputClass} font-mono [-webkit-text-security:disc]`}
            disabled={busy}
            id={id}
            onChange={(event) => update({ secret: event.currentTarget.value })}
            placeholder="sk-…"
            spellCheck={false}
            type="text"
            value={form.secret}
          />
        )}
      />

      {selection ? (
        <fieldset className="rounded-[10px] border border-caution/30 bg-caution/5 px-4 py-3" data-testid="provider-add-selection">
          <legend className="px-1 text-xs font-medium text-ink-secondary">Choose a model available to this key</legend>
          <p className="text-xs leading-5 text-ink-muted">
            This key cannot use the recommended model, so pick the one {label} should start with.
          </p>
          <div className="mt-2 flex flex-col gap-1.5">
            {selection.candidates.map((candidate) => (
              <label className="flex items-center gap-2 text-sm text-ink" key={candidate.candidateId}>
                <input
                  checked={selectedCandidateId === candidate.candidateId}
                  className="size-4 accent-proof"
                  disabled={busy}
                  name="provider-add-candidate"
                  onChange={() => onSelectCandidate(candidate.candidateId)}
                  type="radio"
                />
                {candidate.displayName}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <div className="rounded-[10px] bg-control-surface/60 px-4 py-3" data-testid="provider-add-summary">
        <p className="text-xs font-semibold text-ink-secondary">What Test &amp; Save does</p>
        {snapshotState.kind === "error" ? (
          <p className="mt-1.5 text-xs leading-5 text-critical" role="alert">
            {snapshotState.error}{" "}
            <button className={`underline ${focusRing}`} onClick={onRetrySnapshot} type="button">Try again</button>
          </p>
        ) : (
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs leading-5 text-ink-secondary">
            <li>
              Verifies the key and turns on{" "}
              {candidateNames ? <span className="font-medium text-ink">{candidateNames}</span> : "the recommended models"}
            </li>
            <li>Checks each model for tools, JSON output, PDF and image input</li>
            <li>Makes this key the default for everyone on this connection</li>
          </ul>
        )}
        <p className="mt-2 text-xs leading-5 text-ink-muted">
          Nothing else changes: the default chat model and group access stay as they are.
        </p>
      </div>

      <AdvancedDetails summary="Advanced · endpoint, timeout, private network">
        <Field
          help="Leave the vendor endpoint unless you route through a gateway. A changed endpoint gets its own connection."
          label="Endpoint"
          render={(id) => (
            <input
              aria-invalid={error?.field === "apiRoot" || undefined}
              className={`${inputClass} font-mono text-xs`}
              disabled={busy}
              id={id}
              onChange={(event) => update({ apiRoot: event.currentTarget.value })}
              type="url"
              value={form.apiRoot}
            />
          )}
        />
        <TimeoutField
          disabled={busy}
          invalid={error?.field === "timeout"}
          onChange={(value) => update({ responseTimeoutSeconds: value })}
          value={form.responseTimeoutSeconds}
        />
        <PrivateNetworkField
          checked={form.allowPrivateNetwork}
          disabled={busy}
          onChange={(allowPrivateNetwork) => update({ allowPrivateNetwork })}
        />
      </AdvancedDetails>
    </>
  );
}

function CustomFields({
  busy,
  discovery,
  error,
  form,
  onDiscover,
  onNameTouched,
  onReasoningPathsTouched,
  selectedReasoning,
  update
}: Readonly<{
  busy: boolean;
  discovery: DiscoveryState;
  error: FormError | null;
  form: CustomForm;
  onDiscover(): void;
  onNameTouched(): void;
  onReasoningPathsTouched(): void;
  selectedReasoning: ReturnType<typeof reasoningForChoice>;
  update(patch: Partial<CustomForm>): void;
}>) {
  const modelsLabelId = useId();
  const models = discovery.models;
  const showManual = discovery.attempted && !discovery.loading && (models === null || models.length === 0);
  const toggleModel = (id: string, checked: boolean) => update({
    selectedModelIds: checked
      ? [...form.selectedModelIds, id]
      : form.selectedModelIds.filter((selected) => selected !== id)
  });
  return (
    <>
      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_13rem]">
        <Field
          help="Exact root, no guessing. Public endpoints need HTTPS."
          label="Base URL"
          render={(id) => (
            <input
              aria-invalid={error?.field === "apiRoot" || undefined}
              autoComplete="off"
              className={`${inputClass} font-mono text-xs`}
              disabled={busy}
              id={id}
              onChange={(event) => update({ apiRoot: event.currentTarget.value })}
              placeholder="https://host/v1"
              spellCheck={false}
              type="url"
              value={form.apiRoot}
            />
          )}
        />
        <Field
          label="API style"
          render={(id) => (
            <select
              className={inputClass}
              disabled={busy}
              id={id}
              onChange={(event) => update({ protocol: event.currentTarget.value as CustomForm["protocol"] })}
              value={form.protocol}
            >
              <option value="chat_completions">Chat Completions</option>
              <option value="responses">Responses</option>
            </select>
          )}
        />
      </div>
      <div className="min-w-0">
        <Field
          label="API key"
          render={(id) => (
            <input
              aria-invalid={error?.field === "secret" || undefined}
              autoComplete="off"
              className={`${inputClass} font-mono [-webkit-text-security:disc]`}
              disabled={busy || form.noKey}
              id={id}
              onChange={(event) => update({ secret: event.currentTarget.value })}
              placeholder="sk-…"
              spellCheck={false}
              autoCapitalize="none"
              type="text"
              value={form.secret}
            />
          )}
        />
        <label className="mt-2 flex items-center gap-2 text-xs text-ink-secondary">
          <input
            checked={form.noKey}
            className="size-4 accent-proof"
            disabled={busy}
            onChange={(event) => update({ noKey: event.currentTarget.checked })}
            type="checkbox"
          />
          This endpoint needs no key (private network)
        </label>
        <p className={helpText}>This key is assigned to you personally. Its label does not make it the installation default or give other users access.</p>
      </div>
      <Field
        label="Name"
        render={(id) => (
          <input
            aria-invalid={error?.field === "name" || undefined}
            className={inputClass}
            disabled={busy}
            id={id}
            maxLength={160}
            onChange={(event) => {
              onNameTouched();
              update({ name: event.currentTarget.value });
            }}
            placeholder="Custom · host"
            value={form.name}
          />
        )}
      />

      <div className="min-w-0">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-ink-secondary" id={modelsLabelId}>
            {models ? `Models found on this endpoint · ${models.length}` : "Models on this endpoint"}
          </span>
          <UiV2Button
            busy={discovery.loading}
            disabled={busy}
            icon="regenerate"
            onClick={onDiscover}
            tone="ghost"
            type="button"
          >
            {discovery.attempted ? "Look again" : "Find models"}
          </UiV2Button>
        </div>
        {models && models.length > 0 ? (
          <div
            aria-labelledby={modelsLabelId}
            className="mt-2 max-h-72 overflow-y-auto rounded-[10px] border border-trace-subtle bg-control-surface/45"
            data-testid="provider-add-models"
            role="group"
          >
            {models.map((model) => {
              const { hint, supported } = discoveredModelHint(model);
              const checked = form.selectedModelIds.includes(model.id);
              return (
                <label
                  className={`grid min-h-touch grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-trace-subtle px-3 py-2 last:border-b-0 ${supported ? "" : "opacity-60"}`}
                  key={model.id}
                >
                  <input
                    checked={checked}
                    className="size-4 accent-proof"
                    disabled={busy || !supported}
                    onChange={(event) => toggleModel(model.id, event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <span className="min-w-0">
                    <span className="block break-all font-mono text-[13px] text-ink">{model.id}</span>
                    <span className="block text-xs leading-5 text-ink-muted">Reported: {hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
        ) : null}
        {discovery.error ? (
          <p className="mt-2 text-xs leading-5 text-critical" role="alert">{discovery.error}</p>
        ) : null}
        {models && models.length === 0 ? (
          <p className="mt-2 text-xs leading-5 text-caution" role="status">The endpoint reported no models.</p>
        ) : null}
        <p className={helpText}>
          The endpoint reports these hints. Setup checks each model with small paid requests and enables verified capabilities, including PDF. Successful models are kept if another check fails.
        </p>
        {showManual ? (
          <Field
            className="mt-3"
            help="Enter the model ID by hand when the endpoint does not list its models."
            label="Model ID"
            render={(id) => (
              <input
                aria-invalid={error?.field === "models" || undefined}
                autoComplete="off"
                className={`${inputClass} font-mono text-xs`}
                disabled={busy}
                id={id}
                onChange={(event) => update({ manualModelId: event.currentTarget.value })}
                placeholder="model-id"
                spellCheck={false}
                value={form.manualModelId}
              />
            )}
          />
        ) : null}
      </div>

      <AdvancedDetails summary="Advanced · timeout, private network, reasoning mapping">
        <TimeoutField
          disabled={busy}
          invalid={error?.field === "timeout"}
          onChange={(value) => update({ responseTimeoutSeconds: value })}
          value={form.responseTimeoutSeconds}
        />
        <PrivateNetworkField
          checked={form.allowPrivateNetwork}
          disabled={busy || form.noKey}
          onChange={(allowPrivateNetwork) => update({ allowPrivateNetwork })}
        />
        <Field
          className="sm:max-w-xs"
          help={form.reasoningChoice === "automatic"
            ? "Keep each model's reported reasoning settings. Models without hints use conservative defaults."
            : reasoningCapabilitiesSummary(selectedReasoning)}
          label="Reasoning"
          render={(id) => (
            <select
              className={inputClass}
              disabled={busy}
              id={id}
              onChange={(event) => update({ reasoningChoice: event.currentTarget.value as AdminProviderReasoningChoice })}
              value={form.reasoningChoice}
            >
              <option value="automatic">From the endpoint</option>
              <option value="disabled">Off</option>
              <option value="openai_gpt_5_6_sol">OpenAI GPT-5.6 levels</option>
            </select>
          )}
        />
        {selectedReasoning.reasoning ? (
          <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Field
              help="Dot path in the outbound request, for example reasoning.effort."
              label="Reasoning effort field"
              render={(id) => (
                <input
                  aria-invalid={error?.field === "reasoning" || undefined}
                  className={`${inputClass} font-mono text-xs`}
                  disabled={busy}
                  id={id}
                  onChange={(event) => {
                    onReasoningPathsTouched();
                    update({ reasoningEffortPath: event.currentTarget.value });
                  }}
                  placeholder={compatibleReasoningRequestMappingDefault(form.protocol).effortPath}
                  value={form.reasoningEffortPath}
                />
              )}
            />
            <Field
              label="Reasoning mode field (optional)"
              render={(id) => (
                <input
                  className={`${inputClass} font-mono text-xs`}
                  disabled={busy}
                  id={id}
                  onChange={(event) => {
                    onReasoningPathsTouched();
                    update({ reasoningModePath: event.currentTarget.value });
                  }}
                  placeholder="Not sent"
                  value={form.reasoningModePath}
                />
              )}
            />
          </div>
        ) : null}
      </AdvancedDetails>
    </>
  );
}

/**
 * Add provider sheet (PRD 5.3): six provider tiles, one `Test & Save`. Built-in
 * families go through quick-setup (a second connection of a family gets its
 * own name); Custom discovers the endpoint's models and creates the
 * connection with the chosen ones. Success hands the new connection id to the
 * caller, whose page opens in the checking state started by the server.
 */
export function AdminProviderAddSheet(props: AdminProviderAddSheetProps) {
  if (!props.open) return null;
  const { open: _open, ...rest } = props;
  return <AddSheetBody {...rest} />;
}
