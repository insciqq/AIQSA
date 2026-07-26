"use client";

import {
  adminEmailErrorMessage,
  clearAdminEmail,
  requestAdminEmail,
  runAdminEmailAction,
  saveAdminEmail,
  type AdminEmailClientResult
} from "@/components/admin/adminEmailApi";
import type {
  AdminEmailActionRequest,
  AdminEmailClearRequest,
  AdminEmailSaveRequest,
  AdminEmailState,
  AdminEmailTestResponse
} from "@/lib/contracts/email";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminEmailController = Readonly<{
  actions: Readonly<{
    activate(expectedDraftVersion: number, expectedActiveVersion: number): Promise<boolean>;
    clear(body: AdminEmailClearRequest): Promise<boolean>;
    disable(expectedActiveVersion: number): Promise<boolean>;
    dismissError(): void;
    dismissNotice(): void;
    enable(expectedActiveVersion: number): Promise<boolean>;
    refresh(): Promise<void>;
    save(body: AdminEmailSaveRequest): Promise<boolean>;
    test(expectedDraftVersion: number, recipient: string): Promise<boolean>;
  }>;
  state: Readonly<{
    busy: boolean;
    email: AdminEmailState | null;
    error: string | null;
    loaded: boolean;
    loading: boolean;
    notice: string | null;
  }>;
}>;

type UseAdminEmailControllerOptions = Readonly<{
  active: boolean;
  fetcher?: Fetcher;
  onMutationCommitted?(): void | Promise<unknown>;
}>;

function notifyMutationCommitted(callback: UseAdminEmailControllerOptions["onMutationCommitted"]): void {
  if (!callback) return;
  void Promise.resolve().then(callback).catch(() => undefined);
}

export function useAdminEmailController(input: UseAdminEmailControllerOptions): AdminEmailController {
  const fetcher = input.fetcher ?? fetch;
  const [email, setEmail] = useState<AdminEmailState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);
  const loadRef = useRef<Promise<void> | null>(null);
  const autoLoadAttempted = useRef(false);

  const refresh = useCallback(async () => {
    if (loadRef.current) return loadRef.current;
    const operation = (async () => {
      setLoading(true);
      const result = await requestAdminEmail(fetcher);
      if (result.ok) {
        setEmail(result.data.email);
        setLoaded(true);
        setError(null);
      } else {
        setError(adminEmailErrorMessage(result.error));
      }
      setLoading(false);
    })();
    loadRef.current = operation;
    await operation.finally(() => {
      if (loadRef.current === operation) loadRef.current = null;
    });
  }, [fetcher]);

  useEffect(() => {
    if (!input.active) {
      autoLoadAttempted.current = false;
      return;
    }
    if (!loaded && !loading && !autoLoadAttempted.current) {
      autoLoadAttempted.current = true;
      void refresh();
    }
  }, [input.active, loaded, loading, refresh]);

  const mutate = useCallback(async <T extends { email: AdminEmailState }>(
    operation: () => Promise<AdminEmailClientResult<T>>,
    success: string
  ): Promise<T | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await operation();
      if (!result.ok) {
        setError(adminEmailErrorMessage(result.error));
        return null;
      }
      setEmail(result.data.email);
      setNotice(success);
      return result.data;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const simpleAction = useCallback(async (
    body: Exclude<AdminEmailActionRequest, { action: "test" }>,
    success: string
  ) => Boolean(await mutate(
    () => runAdminEmailAction(body, fetcher) as Promise<AdminEmailClientResult<{ email: AdminEmailState }>>,
    success
  )), [fetcher, mutate]);

  const test = useCallback(async (expectedDraftVersion: number, recipient: string) => {
    const result = await mutate<AdminEmailTestResponse>(
      () => runAdminEmailAction({ action: "test", expectedDraftVersion, recipient }, fetcher) as Promise<AdminEmailClientResult<AdminEmailTestResponse>>,
      "Email test completed."
    );
    if (!result) return false;
    if (!result.test.tested) {
      setNotice(null);
      setError(`The SMTP server did not accept the test message (${result.test.code}).`);
      return false;
    }
    setNotice("The SMTP server accepted the test message. You can activate this draft.");
    return true;
  }, [fetcher, mutate]);

  return useMemo(() => ({
    actions: {
      activate: (expectedDraftVersion: number, expectedActiveVersion: number) => simpleAction({
        action: "activate",
        expectedActiveVersion,
        expectedDraftVersion
      }, "The tested email draft is now active."),
      clear: async (body: AdminEmailClearRequest) => {
        const committed = Boolean(await mutate(
          () => clearAdminEmail(body, fetcher),
          "Email delivery configuration cleared."
        ));
        if (committed) notifyMutationCommitted(input.onMutationCommitted);
        return committed;
      },
      disable: (expectedActiveVersion: number) => simpleAction({
        action: "disable",
        expectedActiveVersion
      }, "Email delivery disabled."),
      dismissError: () => setError(null),
      dismissNotice: () => setNotice(null),
      enable: (expectedActiveVersion: number) => simpleAction({
        action: "enable",
        expectedActiveVersion
      }, "Email delivery enabled."),
      refresh,
      save: async (body: AdminEmailSaveRequest) => {
        const committed = Boolean(await mutate(
          () => saveAdminEmail(body, fetcher),
          "Email draft saved. Test it before activation."
        ));
        if (committed) notifyMutationCommitted(input.onMutationCommitted);
        return committed;
      },
      test
    },
    state: { busy, email, error, loaded, loading, notice }
  }), [
    busy,
    email,
    error,
    fetcher,
    input.onMutationCommitted,
    loaded,
    loading,
    mutate,
    notice,
    refresh,
    simpleAction,
    test
  ]);
}
