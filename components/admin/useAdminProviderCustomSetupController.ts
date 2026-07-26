"use client";

import {
  ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES,
  type AdminProviderCustomSetupReadyResult
} from "@/lib/contracts/adminProviderCustomSetup";
import {
  adminProviderCustomSetupErrorMessage,
  submitAdminProviderCustomSetup
} from "@/components/admin/adminProviderCustomSetupApi";
import { useCallback, useEffect, useRef, useState } from "react";

export type UseAdminProviderCustomSetupControllerOptions = Readonly<{
  onMutationCommitted?(): void | Promise<unknown>;
}>;

type AdminProviderCustomSetupForm = {
  allowPrivateNetwork: boolean;
  apiRoot: string;
  connectionDisplayName: string;
  contextWindow: number;
  defaultMaxOutputTokens: number;
  modelDisplayName: string;
  modelId: string;
  secret: string;
  streaming: boolean;
  toolCalling: boolean;
};

function initialForm(): AdminProviderCustomSetupForm {
  return {
    allowPrivateNetwork: false,
    apiRoot: "",
    connectionDisplayName: "",
    contextWindow: ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES.contextWindow,
    defaultMaxOutputTokens:
      ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES.defaultMaxOutputTokens,
    modelDisplayName: "",
    modelId: "",
    secret: "",
    streaming: ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES.streaming,
    toolCalling: ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES.toolCalling
  };
}

export function useAdminProviderCustomSetupController(
  active: boolean,
  options: UseAdminProviderCustomSetupControllerOptions = {}
) {
  const { onMutationCommitted } = options;
  const [form, setForm] = useState(initialForm);
  const [submitting, setSubmitting] = useState(false);
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
  }, []);

  const leave = useCallback(() => {
    cancel();
    setForm(initialForm());
    setError(null);
    setErrorCode(null);
    setReady(null);
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
    setForm((current) => ({ ...current, ...patch }));
    setError(null);
    setErrorCode(null);
    setReady(null);
  }, []);

  const submit = useCallback(async () => {
    if (submittingRef.current) return false;
    const apiRoot = form.apiRoot.trim();
    const modelId = form.modelId.trim();
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
      !modelId ||
      !Number.isInteger(form.contextWindow) ||
      form.contextWindow < 1 ||
      !Number.isInteger(form.defaultMaxOutputTokens) ||
      form.defaultMaxOutputTokens < 1 ||
      (authenticationMode === "none" &&
        (!form.allowPrivateNetwork || protocol !== "http:"))
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
        streaming: form.streaming,
        toolCalling: form.toolCalling
      },
      confirmPaidRequest: true,
      ...(form.connectionDisplayName.trim()
        ? { connectionDisplayName: form.connectionDisplayName.trim() }
        : {}),
      ...(form.modelDisplayName.trim()
        ? { modelDisplayName: form.modelDisplayName.trim() }
        : {}),
      modelId,
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
  }, [form, onMutationCommitted]);

  return {
    actions: {
      leave,
      submit,
      update
    },
    state: {
      error,
      errorCode,
      form,
      formLocked: submitting,
      ready,
      submitting
    }
  };
}

export type AdminProviderCustomSetupController = ReturnType<
  typeof useAdminProviderCustomSetupController
>;
