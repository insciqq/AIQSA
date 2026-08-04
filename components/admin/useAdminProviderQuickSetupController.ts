"use client";

import {
  adminProviderQuickSetupErrorMessage,
  clearAdminProviderQuickSetupAssignment,
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

export type AdminProviderQuickSetupFeedback = Readonly<{
  message: string;
  tone: "error" | "status";
}>;

type SnapshotFeedbackMode = "initial" | "manual" | "reconcile-clear" |
  "reconcile-setup" | "reconcile-stale";

type ReadyReconciliationExpectation = Readonly<{
  modelDisplayName: string;
  provider: AdminProviderQuickSetupId;
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
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<AdminProviderQuickSetupFeedback | null>(null);

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
    setClearing(false);
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
      provider.provider === confirmation.provider &&
      provider.state === "ready" &&
      provider.model?.displayName === confirmation.model.displayName
    ) ? confirmation : null);
    if (selected?.state === "ready") {
      formGenerationRef.current += 1;
      resetFormState();
    }
  }, [resetFormState]);

  const refreshSnapshot = useCallback(async (
    required = reconciliationRequiredRef.current,
    feedbackMode: SnapshotFeedbackMode = "manual",
    readyExpectation?: ReadyReconciliationExpectation
  ) => {
    if (required) updateReconciliationRequired(true);
    const generation = ++snapshotGenerationRef.current;
    const abort = new AbortController();
    snapshotAbortRef.current?.abort();
    snapshotAbortRef.current = abort;
    snapshotLoadingRef.current = true;
    setLoading(true);
    setRefreshError(null);
    setRefreshErrorCode(null);
    if (feedbackMode === "initial") {
      setFeedback({ message: "Provider Quick setup is loading.", tone: "status" });
    } else if (feedbackMode === "manual") {
      setFeedback({
        message: required
          ? "Confirming saved provider status."
          : "Refreshing provider status.",
        tone: "status"
      });
    }

    const result = await getAdminProviderQuickSetup(fetch, abort.signal);
    if (generation !== snapshotGenerationRef.current) return false;

    snapshotAbortRef.current = null;
    snapshotLoadingRef.current = false;
    setLoading(false);
    setLoaded(true);
    if (!result.ok) {
      const message = adminProviderQuickSetupErrorMessage(result.error);
      setRefreshError(message);
      setRefreshErrorCode(result.error.code);
      setFeedback({
        message: required
          ? `Saved provider status could not be confirmed. ${message}`
          : `Provider status refresh failed. ${message}`,
        tone: "error"
      });
      return false;
    }

    const reconciledReadyProvider = readyExpectation
      ? result.data.providers.find(({ provider }) => provider === readyExpectation.provider)
      : null;
    applySnapshot(result.data);
    if (required || reconciliationRequiredRef.current) {
      updateReconciliationRequired(false);
      setError(null);
      setErrorCode(null);
    }
    if (feedbackMode === "initial") {
      setFeedback({ message: "Provider Quick setup loaded.", tone: "status" });
    } else if (feedbackMode === "manual") {
      setFeedback({
        message: required
          ? "Saved provider status confirmed."
          : "Provider status refreshed.",
        tone: "status"
      });
    } else if (feedbackMode === "reconcile-stale") {
      setFeedback({
        message: "Provider settings changed. Latest provider status loaded.",
        tone: "status"
      });
    } else if (
      feedbackMode === "reconcile-setup" &&
      (reconciledReadyProvider?.state !== "ready" ||
        reconciledReadyProvider.model?.displayName !== readyExpectation?.modelDisplayName)
    ) {
      setFeedback({
        message: "Provider settings changed. Latest provider status loaded.",
        tone: "status"
      });
    }
    return true;
  }, [applySnapshot, updateReconciliationRequired]);

  const reconcileSnapshot = useCallback((
    feedbackMode: Extract<SnapshotFeedbackMode,
      "reconcile-clear" | "reconcile-setup" | "reconcile-stale">,
    readyExpectation?: ReadyReconciliationExpectation
  ) => {
    updateReconciliationRequired(true);
    return refreshSnapshot(true, feedbackMode, readyExpectation);
  }, [refreshSnapshot, updateReconciliationRequired]);

  useEffect(() => {
    if (!active || loaded) return;
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) void refreshSnapshot(false, "initial");
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
      setFeedback(null);
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
    setFeedback(null);
  }, [cancelSubmit, resetFormState]);

  const leaveQuickSetup = useCallback(() => {
    cancelSubmit();
    cancelSnapshot();
    resetFormState();
    updateReconciliationRequired(false);
    setRefreshError(null);
    setRefreshErrorCode(null);
    setFeedback(null);
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
    const providerDisplayName = snapshot?.providers.find((candidate) =>
      candidate.provider === provider
    )?.providerDisplayName ?? provider;
    setFeedback({
      message: `${providerDisplayName} selected. Enter an API key to continue.`,
      tone: "status"
    });
  }, [cancelSubmit, snapshot]);

  const changeSecret = useCallback((value: string) => {
    if (snapshotLoadingRef.current || reconciliationRequiredRef.current || submittingRef.current) return;
    cancelSubmit();
    setSecret(value);
    setSelectedCandidateId(null);
    setSelection(null);
    setError(null);
    setErrorCode(null);
    setFeedback(null);
  }, [cancelSubmit]);

  const submit = useCallback(async () => {
    const provider = selectedProvider;
    const candidateSecret = secret;
    if (!provider || !candidateSecret.trim() ||
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
    setClearing(false);
    setError(null);
    setErrorCode(null);
    setFeedback({
      message: `Testing and saving ${provider.providerDisplayName}.`,
      tone: "status"
    });
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
      const message = adminProviderQuickSetupErrorMessage(result.error);
      setError(message);
      setErrorCode(result.error.code);
      setFeedback({
        message: `${provider.providerDisplayName} setup failed. ${message}`,
        tone: "error"
      });
      if (result.error.code === "provider_quick_setup_selection_invalid") {
        setSelection(null);
        setSelectedCandidateId(null);
      }
      if (result.error.code === "provider_draft_stale") {
        setSelection(null);
        setSelectedCandidateId(null);
        void reconcileSnapshot("reconcile-stale");
      }
      return false;
    }
    if (result.data.provider !== provider.provider) {
      const message = adminProviderQuickSetupErrorMessage({
        code: "provider_quick_setup_response_invalid"
      });
      setError(message);
      setErrorCode("provider_quick_setup_response_invalid");
      setFeedback({
        message: `${provider.providerDisplayName} setup failed. ${message}`,
        tone: "error"
      });
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
        setFeedback({
          message: `${provider.providerDisplayName} setup needs another key check before a model can be selected.`,
          tone: "error"
        });
        return false;
      }
      setSelection(result.data);
      setSelectedCandidateId(null);
      setFeedback({
        message: `${provider.providerDisplayName} needs a model choice. Choose one to finish setup.`,
        tone: "status"
      });
      return false;
    }

    setReadyResult(result.data);
    setReadyConfirmation(result.data);
    setSecret("");
    setSelection(null);
    setSelectedCandidateId(null);
    setReplacing(false);
    setFeedback({
      message: `${provider.providerDisplayName} is ready to chat with ${result.data.model.displayName}.`,
      tone: "status"
    });
    onQuickSetupCommitted?.();
    notifyMutationCommitted(onMutationCommitted);
    void reconcileSnapshot("reconcile-setup", {
      modelDisplayName: result.data.model.displayName,
      provider: result.data.provider
    });
    return true;
  }, [onMutationCommitted, onQuickSetupCommitted, reconcileSnapshot, replacing, secret,
    selectedCandidateId, selectedProvider, selection]);

  const clearAssignment = useCallback(async () => {
    const provider = selectedProvider;
    if (!provider?.quickSetupAssigned || submittingRef.current || snapshotLoadingRef.current ||
      reconciliationRequiredRef.current) {
      return false;
    }
    const mutationGeneration = ++submitGenerationRef.current;
    const formGeneration = formGenerationRef.current;
    const abort = new AbortController();
    submitAbortRef.current?.abort();
    submitAbortRef.current = abort;
    submittingRef.current = true;
    setClearing(true);
    setSubmitting(false);
    setError(null);
    setErrorCode(null);
    setFeedback({
      message: `Removing the ${provider.providerDisplayName} key assignment.`,
      tone: "status"
    });
    const result = await clearAdminProviderQuickSetupAssignment({
      expectedState: provider.stateToken,
      provider: provider.provider
    }, fetch, abort.signal);
    if (mutationGeneration !== submitGenerationRef.current ||
      formGeneration !== formGenerationRef.current) {
      if (mutationGeneration === submitGenerationRef.current) {
        submitAbortRef.current = null;
        submittingRef.current = false;
        setClearing(false);
      }
      return false;
    }
    submitAbortRef.current = null;
    submittingRef.current = false;
    setClearing(false);
    if (!result.ok) {
      const message = adminProviderQuickSetupErrorMessage(result.error);
      setError(message);
      setErrorCode(result.error.code);
      setFeedback({
        message: `${provider.providerDisplayName} key assignment could not be removed. ${message}`,
        tone: "error"
      });
      if (result.error.code === "provider_draft_stale") {
        void reconcileSnapshot("reconcile-stale");
      }
      return false;
    }
    if (result.data.provider !== provider.provider || !result.data.credentialRetained) {
      const message = adminProviderQuickSetupErrorMessage({
        code: "provider_quick_setup_response_invalid"
      });
      setError(message);
      setErrorCode("provider_quick_setup_response_invalid");
      setFeedback({
        message: `${provider.providerDisplayName} key assignment could not be removed. ${message}`,
        tone: "error"
      });
      return false;
    }
    setReadyResult(null);
    setReadyConfirmation(null);
    setReplacing(false);
    setFeedback({
      message: `${provider.providerDisplayName} key assignment was removed. The stored credential remains available in Connections.`,
      tone: "status"
    });
    onQuickSetupCommitted?.();
    notifyMutationCommitted(onMutationCommitted);
    void reconcileSnapshot("reconcile-clear");
    return true;
  }, [onMutationCommitted, onQuickSetupCommitted, reconcileSnapshot, selectedProvider]);

  const formLocked = submitting || clearing || loading || reconciliationRequired;

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
        setFeedback({
          message: `Enter a replacement ${selectedProvider?.providerDisplayName ?? "provider"} API key.`,
          tone: "status"
        });
      },
      cancelReplacement: clearForm,
      changeSecret,
      clearAssignment,
      chooseModel: (candidateId: string) => {
        if (submittingRef.current || snapshotLoadingRef.current ||
          reconciliationRequiredRef.current) return;
        setSelectedCandidateId(candidateId);
        setError(null);
        setErrorCode(null);
        const candidate = selection?.candidates.find((item) =>
          item.candidateId === candidateId
        );
        setFeedback({
          message: candidate
            ? `${candidate.displayName} selected. Submit again to finish setup.`
            : "Model selected. Submit again to finish setup.",
          tone: "status"
        });
      },
      clearError: () => {
        setError(null);
        setErrorCode(null);
        setFeedback(null);
      },
      leaveQuickSetup,
      refresh: () => refreshSnapshot(reconciliationRequiredRef.current, "manual"),
      selectProvider,
      submit
    },
    state: {
      error,
      errorCode,
      feedback,
      clearing,
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
