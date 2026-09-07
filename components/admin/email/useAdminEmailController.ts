"use client";

import {
  adminEmailErrorMessage,
  clearAdminEmail,
  requestAdminEmail,
  runAdminEmailAction,
  testAndActivateAdminEmail
} from "@/components/admin/email/adminEmailApi";
import { emailAttemptMessage } from "@/components/admin/email/emailView";
import type { AdminEmailDraftInput, AdminEmailState } from "@/lib/contracts/email";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AdminEmailTestAndActivateOutcome =
  | Readonly<{ ok: true }>
  | Readonly<{ message: string; ok: false }>;

export type AdminEmailController = Readonly<{
  actions: Readonly<{
    /** Removes the stored settings after the shared confirmation; reports through the feedback host. */
    clear(): Promise<boolean>;
    refresh(): Promise<void>;
    /** Turns delivery on or off for the active settings; reports through the feedback host. */
    setEnabled(enabled: boolean): Promise<boolean>;
    /**
     * Stores the settings, sends one test message and activates as one server
     * operation (PRD B6). Success is reported as a notice; a failure comes back
     * as the message to show in the form, with the fields preserved.
     */
    testAndActivate(input: Readonly<{ draft: AdminEmailDraftInput; testRecipient: string }>): Promise<AdminEmailTestAndActivateOutcome>;
  }>;
  state: Readonly<{
    busy: boolean;
    email: AdminEmailState | null;
    error: string | null;
    loaded: boolean;
    loading: boolean;
  }>;
}>;

export type AdminEmailControllerOptions = Readonly<{
  active: boolean;
  onError(message: string): void;
  onMutationCommitted?(): void | Promise<unknown>;
  onNotice(message: string): void;
}>;

function notifyMutationCommitted(callback: AdminEmailControllerOptions["onMutationCommitted"]): void {
  if (!callback) return;
  void Promise.resolve().then(callback).catch(() => undefined);
}

/**
 * The one state owner of the Email page: the state the server returned last
 * and one busy flag. Every mutation replaces the state with the server's
 * answer; whole-action outcomes go to the shared feedback host.
 */
export function useAdminEmailController({
  active,
  onError,
  onMutationCommitted,
  onNotice
}: AdminEmailControllerOptions): AdminEmailController {
  const [email, setEmail] = useState<AdminEmailState | null>(null);
  const [loading, setLoading] = useState(active);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailRef = useRef<AdminEmailState | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const replace = useCallback((next: AdminEmailState) => {
    emailRef.current = next;
    setEmail(next);
  }, []);

  const apply = useCallback((result: Awaited<ReturnType<typeof requestAdminEmail>>) => {
    setLoading(false);
    setLoaded(true);
    if (result.ok) {
      setError(null);
      replace(result.data.email);
    } else {
      setError(adminEmailErrorMessage(result.error));
    }
  }, [replace]);

  // The first load relies on the initial `loading` state and applies the
  // answer from the response callback; a later refresh flips loading on first.
  useEffect(() => {
    if (!active) return;
    const generation = ++generationRef.current;
    void requestAdminEmail().then((result) => {
      if (!mountedRef.current || generation !== generationRef.current) return;
      apply(result);
    });
  }, [active, apply]);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    const result = await requestAdminEmail();
    if (!mountedRef.current || generation !== generationRef.current) return;
    apply(result);
  }, [apply]);

  const guard = useCallback(async <T,>(operation: () => Promise<T>, idle: T): Promise<T> => {
    if (busyRef.current) return idle;
    busyRef.current = true;
    setBusy(true);
    try {
      return await operation();
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, []);

  const actions = useMemo<AdminEmailController["actions"]>(() => ({
    clear: () => guard(async () => {
      const current = emailRef.current;
      if (!current) return false;
      const result = await clearAdminEmail({
        confirm: true,
        expectedActiveVersion: current.active.version,
        expectedDraftVersion: current.draft.version
      });
      if (!mountedRef.current) return false;
      if (!result.ok) {
        onError(adminEmailErrorMessage(result.error));
        return false;
      }
      replace(result.data.email);
      onNotice("Email configuration cleared.");
      notifyMutationCommitted(onMutationCommitted);
      return true;
    }, false),

    refresh: load,

    setEnabled: (enabled) => guard(async () => {
      const current = emailRef.current;
      if (!current) return false;
      const result = await runAdminEmailAction({
        action: enabled ? "enable" : "disable",
        expectedActiveVersion: current.active.version
      });
      if (!mountedRef.current) return false;
      if (!result.ok) {
        onError(adminEmailErrorMessage(result.error));
        return false;
      }
      replace(result.data.email);
      onNotice(enabled ? "Email delivery turned on." : "Email delivery turned off.");
      notifyMutationCommitted(onMutationCommitted);
      return true;
    }, false),

    testAndActivate: ({ draft, testRecipient }) => guard<AdminEmailTestAndActivateOutcome>(async () => {
      const current = emailRef.current;
      if (!current) return { message: adminEmailErrorMessage("email_admin_action_failed"), ok: false };
      const result = await testAndActivateAdminEmail({
        action: "test_and_activate",
        draft,
        expectedActiveVersion: current.active.version,
        testRecipient
      });
      if (!mountedRef.current) return { message: "", ok: false };
      if (result.ok) {
        replace(result.data.email);
        onNotice(`Test message sent to ${testRecipient}. Email delivery is active.`);
        notifyMutationCommitted(onMutationCommitted);
        return { ok: true };
      }
      if (result.testFailure) {
        // The settings are stored for the next attempt; the previous delivery configuration stays in use.
        replace(result.testFailure.email);
        return { message: emailAttemptMessage(result.testFailure.code), ok: false };
      }
      if (result.error === "email_active_conflict" || result.error === "email_draft_conflict") {
        void load();
      }
      return { message: adminEmailErrorMessage(result.error), ok: false };
    }, { message: "", ok: false })
  }), [guard, load, onError, onMutationCommitted, onNotice, replace]);

  return useMemo(() => ({
    actions,
    state: { busy, email, error, loaded, loading }
  }), [actions, busy, email, error, loaded, loading]);
}
