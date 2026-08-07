"use client";

import {
  ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES,
  MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS,
  type AdminProviderCustomDiscoveredModel,
  type AdminProviderCustomProtocol,
  type AdminProviderCustomSetupReadyResult
} from "@/lib/contracts/adminProviderCustomSetup";
import {
  adminProviderCustomSetupErrorMessage,
  discoverAdminProviderCustomModels,
  submitAdminProviderCustomSetup
} from "@/components/admin/adminProviderCustomSetupApi";
import {
  reasoningForChoice,
  type AdminProviderReasoningChoice
} from "@/components/admin/adminProviderReasoning";
import { useCallback, useEffect, useRef, useState } from "react";
import { compatibleReasoningRequestMappingDefault } from "@/lib/contracts/providerReasoningRequestMapping";
import {
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_DEFAULT_SECONDS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS,
  ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS
} from "@/lib/contracts/adminProviders";

export type UseAdminProviderCustomSetupControllerOptions = Readonly<{
  onMutationCommitted?(): void | Promise<unknown>;
}>;

type AdminProviderCustomSetupForm = {
  allowPrivateNetwork: boolean;
  apiRoot: string;
  connectionDisplayName: string;
  contextWindow: number;
  defaultMaxOutputTokens: number;
  imageGeneration: boolean;
  modelDisplayName: string;
  modelId: string;
  selectedModelIds: string[];
  protocol: AdminProviderCustomProtocol;
  reasoningChoice: AdminProviderReasoningChoice;
  reasoningEffortPath: string;
  reasoningModePath: string;
  responseTimeoutSeconds: string;
  secret: string;
  streaming: boolean;
  streamUsage: boolean;
  toolCalling: boolean;
  webSearch: boolean;
};

function initialForm(): AdminProviderCustomSetupForm {
  return {
    allowPrivateNetwork: false,
    apiRoot: "",
    connectionDisplayName: "",
    contextWindow: ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES.contextWindow,
    defaultMaxOutputTokens:
      ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES.defaultMaxOutputTokens,
    imageGeneration: false,
    modelDisplayName: "",
    modelId: "",
    selectedModelIds: [],
    protocol: "chat_completions",
    reasoningChoice: "automatic",
    reasoningEffortPath: compatibleReasoningRequestMappingDefault("chat_completions").effortPath,
    reasoningModePath: "",
    responseTimeoutSeconds: String(ADMIN_PROVIDER_RESPONSE_TIMEOUT_DEFAULT_SECONDS),
    secret: "",
    streaming: ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES.streaming,
    streamUsage: false,
    toolCalling: ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES.toolCalling,
    webSearch: false
  };
}

export function useAdminProviderCustomSetupController(
  active: boolean,
  options: UseAdminProviderCustomSetupControllerOptions = {}
) {
  const { onMutationCommitted } = options;
  const [form, setForm] = useState(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<
    AdminProviderCustomDiscoveredModel[] | null
  >(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [ready, setReady] = useState<AdminProviderCustomSetupReadyResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const submittingRef = useRef(false);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    submittingRef.current = false;
    setSubmitting(false);
    setDiscovering(false);
  }, []);

  const leave = useCallback(() => {
    cancel();
    setForm(initialForm());
    setError(null);
    setErrorCode(null);
    setReady(null);
    setDiscoveredModels(null);
    setDiscoveryError(null);
  }, [cancel]);

  useEffect(() => {
    if (active) return;
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) leave();
    });
    return () => {
      disposed = true;
    };
  }, [active, leave]);

  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
    generationRef.current += 1;
    submittingRef.current = false;
  }, []);

  const update = useCallback((patch: Partial<AdminProviderCustomSetupForm>) => {
    if (submittingRef.current) return;
    setForm((current) => ({
      ...current,
      ...patch,
      ...(
        "allowPrivateNetwork" in patch ||
        "apiRoot" in patch ||
        "secret" in patch
          ? { selectedModelIds: [] }
          : {}
      )
    }));
    if (
      "allowPrivateNetwork" in patch ||
      "apiRoot" in patch ||
      "secret" in patch
    ) {
      setDiscoveredModels(null);
      setDiscoveryError(null);
    }
    setError(null);
    setErrorCode(null);
    setReady(null);
  }, []);

  const discoverModels = useCallback(async () => {
    if (submittingRef.current) return false;
    const apiRoot = form.apiRoot.trim();
    const secret = form.secret.trim();
    const authenticationMode = secret ? "bearer" as const : "none" as const;
    let protocol: string | null = null;
    try {
      protocol = new URL(apiRoot).protocol;
    } catch {
      protocol = null;
    }
    if (
      !apiRoot ||
      !/^\d+$/u.test(form.responseTimeoutSeconds) ||
      !Number.isSafeInteger(Number(form.responseTimeoutSeconds)) ||
      Number(form.responseTimeoutSeconds) < ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS ||
      Number(form.responseTimeoutSeconds) > ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS ||
      (authenticationMode === "none" &&
        (!form.allowPrivateNetwork || protocol !== "http:"))
    ) {
      const code = "provider_configuration_invalid";
      setDiscoveryError(adminProviderCustomSetupErrorMessage({ code }));
      return false;
    }

    const generation = ++generationRef.current;
    const abort = new AbortController();
    abortRef.current?.abort();
    abortRef.current = abort;
    submittingRef.current = true;
    setDiscovering(true);
    setDiscoveryError(null);
    setDiscoveredModels(null);
    const result = await discoverAdminProviderCustomModels({
      allowPrivateNetwork: form.allowPrivateNetwork,
      apiRoot,
      authenticationMode,
      responseTimeoutSeconds: Number(form.responseTimeoutSeconds),
      ...(secret ? { secret } : {})
    }, fetch, abort.signal);
    if (generation !== generationRef.current) return false;

    abortRef.current = null;
    submittingRef.current = false;
    setDiscovering(false);
    if (!result.ok) {
      if (result.error.code === "request_aborted") return false;
      setDiscoveryError(adminProviderCustomSetupErrorMessage(result.error));
      return false;
    }
    setDiscoveredModels(result.data.models);
    setForm((current) => ({
      ...current,
      ...(result.data.models.length === 1 ? {
        contextWindow: result.data.models[0]!.capabilities.contextWindow ?? current.contextWindow,
        defaultMaxOutputTokens:
          result.data.models[0]!.capabilities.defaultMaxOutputTokens ?? current.defaultMaxOutputTokens
      } : {}),
      selectedModelIds: result.data.models.length === 1
        ? [result.data.models[0]!.id]
        : []
    }));
    return true;
  }, [
    form.allowPrivateNetwork,
    form.apiRoot,
    form.responseTimeoutSeconds,
    form.secret
  ]);

  const selectDiscoveredModel = useCallback((modelId: string) => {
    if (submittingRef.current) return;
    setForm((current) => current.selectedModelIds.includes(modelId) ||
      current.selectedModelIds.length >= MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS
      ? current
      : {
          ...current,
          selectedModelIds: [...current.selectedModelIds, modelId]
        });
    setError(null);
    setErrorCode(null);
    setReady(null);
  }, []);

  const removeDiscoveredModel = useCallback((modelId: string) => {
    if (submittingRef.current) return;
    setForm((current) => ({
      ...current,
      selectedModelIds: current.selectedModelIds.filter((id) => id !== modelId)
    }));
    setError(null);
    setErrorCode(null);
    setReady(null);
  }, []);

  const clearDiscoveredModels = useCallback(() => {
    if (submittingRef.current) return;
    setForm((current) => ({ ...current, selectedModelIds: [] }));
    setError(null);
    setErrorCode(null);
    setReady(null);
  }, []);

  const selectAllDiscoveredModels = useCallback(() => {
    if (submittingRef.current) return;
    setForm((current) => ({
      ...current,
      selectedModelIds: (discoveredModels ?? [])
        .slice(0, MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS)
        .map(({ id }) => id)
    }));
    setError(null);
    setErrorCode(null);
    setReady(null);
  }, [discoveredModels]);

  const submit = useCallback(async () => {
    if (submittingRef.current) return false;
    const apiRoot = form.apiRoot.trim();
    const modelId = form.modelId.trim();
    const usesDiscoveredModels = Boolean(discoveredModels?.length);
    const modelIds = usesDiscoveredModels ? form.selectedModelIds : [];
    const secret = form.secret.trim();
    const authenticationMode = secret ? "bearer" as const : "none" as const;
    const selectedDiscoveredModels = (discoveredModels ?? []).filter(({ id }) =>
      modelIds.includes(id)
    );
    const reasoning = reasoningForChoice(form.reasoningChoice, selectedDiscoveredModels);
    let protocol: string | null = null;
    try {
      protocol = new URL(apiRoot).protocol;
    } catch {
      protocol = null;
    }
    if (
      !apiRoot ||
      (usesDiscoveredModels ? modelIds.length < 1 : !modelId) ||
      !Number.isInteger(form.contextWindow) ||
      form.contextWindow < 1 ||
      !Number.isInteger(form.defaultMaxOutputTokens) ||
      form.defaultMaxOutputTokens < 1 ||
      !/^\d+$/u.test(form.responseTimeoutSeconds) ||
      !Number.isSafeInteger(Number(form.responseTimeoutSeconds)) ||
      Number(form.responseTimeoutSeconds) < ADMIN_PROVIDER_RESPONSE_TIMEOUT_MIN_SECONDS ||
      Number(form.responseTimeoutSeconds) > ADMIN_PROVIDER_RESPONSE_TIMEOUT_MAX_SECONDS ||
      (reasoning.reasoning && !form.reasoningEffortPath.trim()) ||
      (authenticationMode === "none" &&
        (!form.allowPrivateNetwork || protocol !== "http:" ||
          form.protocol !== "chat_completions"))
    ) {
      const code = "provider_configuration_invalid";
      setErrorCode(code);
      setError(adminProviderCustomSetupErrorMessage({ code }));
      return false;
    }

    const generation = ++generationRef.current;
    const abort = new AbortController();
    abortRef.current?.abort();
    abortRef.current = abort;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setErrorCode(null);
    const result = await submitAdminProviderCustomSetup({
      allowPrivateNetwork: form.allowPrivateNetwork,
      apiRoot,
      authenticationMode,
      capabilities: {
        ...ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES,
        contextWindow: form.contextWindow,
        defaultMaxOutputTokens: form.defaultMaxOutputTokens,
        nativeImageGeneration: form.imageGeneration,
        nativeSearch: form.webSearch,
        ...reasoning,
        streaming: form.streaming,
        ...(form.protocol === "chat_completions" && form.streamUsage
          ? { streamUsage: true }
          : {}),
        toolCalling: form.toolCalling
      },
      confirmPaidRequest: true,
      ...(form.connectionDisplayName.trim()
        ? { connectionDisplayName: form.connectionDisplayName.trim() }
        : {}),
      ...(form.modelDisplayName.trim() && (!usesDiscoveredModels || modelIds.length === 1)
        ? { modelDisplayName: form.modelDisplayName.trim() }
        : {}),
      ...(usesDiscoveredModels ? { modelIds } : { modelId }),
      protocol: form.protocol,
      responseTimeoutSeconds: Number(form.responseTimeoutSeconds),
      ...(reasoning.reasoning
        ? {
            reasoningRequestMapping: {
              effortPath: form.reasoningEffortPath.trim(),
              ...(form.reasoningModePath.trim()
                ? { modePath: form.reasoningModePath.trim() }
                : {})
            }
          }
        : {}),
      ...(secret ? { secret } : {})
    }, fetch, abort.signal);
    if (generation !== generationRef.current) return false;

    abortRef.current = null;
    submittingRef.current = false;
    setSubmitting(false);
    if (!result.ok) {
      if (result.error.code === "request_aborted") return false;
      setErrorCode(result.error.code);
      setError(adminProviderCustomSetupErrorMessage(result.error));
      return false;
    }

    setForm((current) => ({ ...current, secret: "" }));
    setReady(result.data);
    void Promise.resolve(onMutationCommitted?.()).catch(() => undefined);
    return true;
  }, [discoveredModels, form, onMutationCommitted]);

  return {
    actions: {
      clearDiscoveredModels,
      discoverModels,
      leave,
      removeDiscoveredModel,
      selectAllDiscoveredModels,
      selectDiscoveredModel,
      submit,
      update
    },
    state: {
      error,
      errorCode,
      discoveredModels,
      discovering,
      discoveryError,
      form,
      formLocked: submitting || discovering,
      ready,
      submitting
    }
  };
}

export type AdminProviderCustomSetupController = ReturnType<
  typeof useAdminProviderCustomSetupController
>;
