"use client";

import {
  adminProviderQuickSetupErrorMessage,
  getAdminProviderQuickSetup,
  submitAdminProviderQuickSetup,
  type AdminProviderQuickSetupId,
  type AdminProviderQuickSetupProvider,
  type AdminProviderQuickSetupReadyResult,
  type AdminProviderQuickSetupSelectionResult,
  type AdminProviderQuickSetupSnapshot
} from "@/components/admin/adminProviderQuickSetupApi";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type UseAdminProviderQuickSetupControllerOptions = Readonly<{
  onMutationCommitted?(): void | Promise<unknown>;
  onQuickSetupCommitted?(): void;
}>;

function notifyMutationCommitted(
  callback: UseAdminProviderQuickSetupControllerOptions["onMutationCommitted"]
): void {
  if (!callback) return;
  void Promise.resolve().then(callback).catch(() => undefined);
}

export function useAdminProviderQuickSetupController(
  active: boolean,
  options: UseAdminProviderQuickSetupControllerOptions = {}
) {
  const { onMutationCommitted, onQuickSetupCommitted } = options;
  const [snapshot, setSnapshot] = useState<AdminProviderQuickSetupSnapshot | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<AdminProviderQuickSetupId | null>(null);
  const [secret, setSecret] = useState("");
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [selection, setSelection] = useState<AdminProviderQuickSetupSelectionResult | null>(null);
  const [readyResult, setReadyResult] = useState<AdminProviderQuickSetupReadyResult | null>(null);
  const [readyConfirmation, setReadyConfirmation] = useState<
    AdminProviderQuickSetupReadyResult | null
  >(null);
  const [replacing, setReplacing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reconciliationRequired, setReconciliationRequired] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshErrorCode, setRefreshErrorCode] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const selectedProviderIdRef = useRef<AdminProviderQuickSetupId | null>(null);
  const snapshotGenerationRef = useRef(0);
  const snapshotAbortRef = useRef<AbortController | null>(null);
  const snapshotLoadingRef = useRef(false);
  const reconciliationRequiredRef = useRef(false);
  const submitGenerationRef = useRef(0);
  const formGenerationRef = useRef(0);
  const submittingRef = useRef(false);
  const submitAbortRef = useRef<AbortController | null>(null);

  const updateReconciliationRequired = useCallback((required: boolean) => {
    reconciliationRequiredRef.current = required;
    setReconciliationRequired(required);
  }, []);

  const cancelSubmit = useCallback(() => {
    submitGenerationRef.current += 1;
    formGenerationRef.current += 1;
    submitAbortRef.current?.abort();
    submitAbortRef.current = null;
    submittingRef.current = false;
    setSubmitting(false);
  }, []);

  const cancelSnapshot = useCallback(() => {
    snapshotGenerationRef.current += 1;
    snapshotAbortRef.current?.abort();
    snapshotAbortRef.current = null;
    snapshotLoadingRef.current = false;
    setLoading(false);
  }, []);

  const resetFormState = useCallback(() => {
    setSecret("");
    setSelectedCandidateId(null);
    setSelection(null);
    setReplacing(false);
    setError(null);
    setErrorCode(null);
  }, []);

  const applySnapshot = useCallback((next: AdminProviderQuickSetupSnapshot) => {
    const current = selectedProviderIdRef.current;
    const nextSelected = current && next.providers.some(({ provider }) => provider === current)
      ? current
      : next.suggestedProvider;
    const selected = next.providers.find(({ provider }) => provider === nextSelected) ?? null;

    selectedProviderIdRef.current = nextSelected;
    setSelectedProviderId(nextSelected);
    setSnapshot(next);
    setReadyResult(null);
    setReadyConfirmation((confirmation) => confirmation && next.providers.some((provider) =>
      provider.provider === confirmation.provider && provider.state === "ready"
    ) ? confirmation : null);
    if (selected?.state === "ready") {
      formGenerationRef.current += 1;
      resetFormState();
    }
  }, [resetFormState]);

  const refreshSnapshot = useCallback(async (required = reconciliationRequiredRef.current) => {
    if (required) updateReconciliationRequired(true);
    const generation = ++snapshotGenerationRef.current;
    const abort = new AbortController();
    snapshotAbortRef.current?.abort();
    snapshotAbortRef.current = abort;
    snapshotLoadingRef.current = true;
    setLoading(true);
    setRefreshError(null);
    setRefreshErrorCode(null);

    const result = await getAdminProviderQuickSetup(fetch, abort.signal);
    if (generation !== snapshotGenerationRef.current) return false;

    snapshotAbortRef.current = null;
    snapshotLoadingRef.current = false;
    setLoading(false);
    setLoaded(true);
    if (!result.ok) {
      setRefreshError(adminProviderQuickSetupErrorMessage(result.error));
      setRefreshErrorCode(result.error.code);
      return false;
    }

    applySnapshot(result.data);
    if (required || reconciliationRequiredRef.current) {
      updateReconciliationRequired(false);
    }
    return true;
  }, [applySnapshot, updateReconciliationRequired]);

  const reconcileSnapshot = useCallback(() => {
    updateReconciliationRequired(true);
    return refreshSnapshot(true);
  }, [refreshSnapshot, updateReconciliationRequired]);

  useEffect(() => {
    if (!active || loaded) return;
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) void refreshSnapshot(false);
    });
    return () => {
      disposed = true;
      snapshotAbortRef.current?.abort();
      snapshotAbortRef.current = null;
      snapshotLoadingRef.current = false;
      snapshotGenerationRef.current += 1;
    };
  }, [active, loaded, refreshSnapshot]);

  useEffect(() => {
    if (active) return;
    let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      cancelSubmit();
      cancelSnapshot();
      resetFormState();
      updateReconciliationRequired(false);
      setRefreshError(null);
      setRefreshErrorCode(null);
      setLoaded(false);
    });
    return () => {
      disposed = true;
    };
  }, [active, cancelSnapshot, cancelSubmit, resetFormState, updateReconciliationRequired]);

  useEffect(() => () => {
    snapshotAbortRef.current?.abort();
    submitAbortRef.current?.abort();
    snapshotAbortRef.current = null;
    submitAbortRef.current = null;
    snapshotLoadingRef.current = false;
    submittingRef.current = false;
    snapshotGenerationRef.current += 1;
    submitGenerationRef.current += 1;
    formGenerationRef.current += 1;
  }, []);

  const selectedProvider = useMemo<AdminProviderQuickSetupProvider | null>(() => {
    const persisted = snapshot?.providers.find(({ provider }) => provider === selectedProviderId) ?? null;
    if (!persisted || readyResult?.provider !== selectedProviderId) return persisted;
    return {
      ...persisted,
      model: readyResult.model,
      providerDisplayName: readyResult.providerDisplayName,
      state: "ready"
    };
  }, [readyResult, selectedProviderId, snapshot]);

  const clearForm = useCallback(() => {
    cancelSubmit();
    resetFormState();
  }, [cancelSubmit, resetFormState]);

  const leaveQuickSetup = useCallback(() => {
    cancelSubmit();
    cancelSnapshot();
    resetFormState();
    updateReconciliationRequired(false);
    setRefreshError(null);
    setRefreshErrorCode(null);
  }, [cancelSnapshot, cancelSubmit, resetFormState, updateReconciliationRequired]);

  const selectProvider = useCallback((provider: AdminProviderQuickSetupId) => {
    if (snapshotLoadingRef.current || reconciliationRequiredRef.current || submittingRef.current) return;
    cancelSubmit();
    selectedProviderIdRef.current = provider;
    setSelectedProviderId(provider);
    setSecret("");
    setSelectedCandidateId(null);
    setSelection(null);
    setReadyResult(null);
    setReadyConfirmation(null);
    setReplacing(false);
    setError(null);
    setErrorCode(null);
  }, [cancelSubmit]);

  const changeSecret = useCallback((value: string) => {
    if (snapshotLoadingRef.current || reconciliationRequiredRef.current || submittingRef.current) return;
    cancelSubmit();
    setSecret(value);
    setSelectedCandidateId(null);
    setSelection(null);
    setError(null);
    setErrorCode(null);
  }, [cancelSubmit]);

  const submit = useCallback(async () => {
    const provider = selectedProvider;
    const candidateSecret = secret;
    if (!provider || provider.state === "advanced_required" || !candidateSecret.trim() ||
      submittingRef.current || snapshotLoadingRef.current || reconciliationRequiredRef.current) {
      return false;
    }
    const candidate = selection && selection.provider === provider.provider && selectedCandidateId
      ? {
          candidateId: selectedCandidateId,
          policyVersion: selection.policyVersion
        }
      : undefined;
    if (selection && !candidate) return false;

    const submitGeneration = ++submitGenerationRef.current;
    const formGeneration = formGenerationRef.current;
    const replacementRequest = replacing;
    const abort = new AbortController();
    submitAbortRef.current?.abort();
    submitAbortRef.current = abort;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setErrorCode(null);
    const result = await submitAdminProviderQuickSetup({
      expectedState: selection?.expectedState ?? provider.stateToken,
      provider: provider.provider,
      secret: candidateSecret,
      ...(candidate ? { selectedModel: candidate } : {})
    }, fetch, abort.signal);
    if (submitGeneration !== submitGenerationRef.current ||
      formGeneration !== formGenerationRef.current) {
      if (submitGeneration === submitGenerationRef.current) {
        submitAbortRef.current = null;
        submittingRef.current = false;
        setSubmitting(false);
      }
      return false;
    }

    submitAbortRef.current = null;
    submittingRef.current = false;
    setSubmitting(false);
    if (!result.ok) {
      setError(adminProviderQuickSetupErrorMessage(result.error));
      setErrorCode(result.error.code);
      if (result.error.code === "provider_quick_setup_selection_invalid") {
        setSelection(null);
        setSelectedCandidateId(null);
      }
      if (result.error.code === "provider_draft_stale") {
        setSelection(null);
        setSelectedCandidateId(null);
        void reconcileSnapshot();
      }
      return false;
    }
    if (result.data.provider !== provider.provider) {
      setError(adminProviderQuickSetupErrorMessage({ code: "provider_quick_setup_response_invalid" }));
      setErrorCode("provider_quick_setup_response_invalid");
      return false;
    }
    if (result.data.outcome === "selection_required") {
      if (replacementRequest) {
        setSelection(null);
        setSelectedCandidateId(null);
        setError(adminProviderQuickSetupErrorMessage({
          code: "provider_quick_setup_selection_invalid"
        }));
        setErrorCode("provider_quick_setup_selection_invalid");
        return false;
      }
      setSelection(result.data);
      setSelectedCandidateId(null);
      return false;
    }

    setReadyResult(result.data);
    setReadyConfirmation(result.data);
    setSecret("");
    setSelection(null);
    setSelectedCandidateId(null);
    setReplacing(false);
    onQuickSetupCommitted?.();
    notifyMutationCommitted(onMutationCommitted);
    void reconcileSnapshot();
    return true;
  }, [onMutationCommitted, onQuickSetupCommitted, reconcileSnapshot, replacing, secret,
    selectedCandidateId, selectedProvider, selection]);

  const formLocked = submitting || loading || reconciliationRequired;

  return {
    actions: {
      beginReplacement: () => {
        if (snapshotLoadingRef.current || reconciliationRequiredRef.current || submittingRef.current) return;
        cancelSubmit();
        setSecret("");
        setSelection(null);
        setSelectedCandidateId(null);
        setReplacing(true);
        setError(null);
        setErrorCode(null);
      },
      cancelReplacement: clearForm,
      changeSecret,
      chooseModel: (candidateId: string) => {
        if (submittingRef.current || snapshotLoadingRef.current ||
          reconciliationRequiredRef.current) return;
        setSelectedCandidateId(candidateId);
        setError(null);
        setErrorCode(null);
      },
      clearError: () => {
        setError(null);
        setErrorCode(null);
      },
      leaveQuickSetup,
      refresh: () => refreshSnapshot(reconciliationRequiredRef.current),
      selectProvider,
      submit
    },
    state: {
      error,
      errorCode,
      formLocked,
      loaded,
      loading,
      readyResult,
      readyConfirmation,
      reconciliationRequired,
      refreshError,
      refreshErrorCode,
      replacing,
      secret,
      selectedCandidateId,
      selectedProvider,
      selectedProviderId,
      selection,
      snapshot,
      submitting
    }
  };
}

export type AdminProviderQuickSetupController = ReturnType<
  typeof useAdminProviderQuickSetupController
>;
