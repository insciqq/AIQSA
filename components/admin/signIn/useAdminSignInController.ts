"use client";

import {
  adminSignInErrorMessage,
  requestAdminSignIn,
  runAdminSignInMethodAction,
  saveAdminSignInDraft,
  saveAdminSignInPolicy,
  testAdminSignInMethod
} from "@/components/admin/signIn/adminSignInApi";
import { signInMethodLabels, signInTestMessage } from "@/components/admin/signIn/signInView";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type {
  AdminSignInMethodState,
  AdminSignInOverview,
  AdminSignInSecretAction
} from "@/lib/contracts/adminSignIn";
import type { AuthSignInMethod } from "@/lib/contracts/authSignInMethods";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** An action's result for the card that started it; whole-page outcomes go to the feedback host. */
export type AdminSignInOutcome = Readonly<{ ok: true }> | Readonly<{ message: string; ok: false }>;

export type AdminSignInDraftInput = Readonly<{
  config: unknown;
  secretActions: Record<string, AdminSignInSecretAction>;
}>;

export type AdminSignInController = Readonly<{
  actions: Readonly<{
    /** Activates the saved draft; a changed identity source asks for confirmation first. */
    activate(method: AuthSignInMethod): Promise<AdminSignInOutcome>;
    /** Turns an admin configuration off after confirmation; the environment fallback applies again. */
    requestDisable(method: AuthSignInMethod): void;
    refresh(): Promise<void>;
    saveDraft(method: AuthSignInMethod, draft: AdminSignInDraftInput): Promise<AdminSignInOutcome>;
    setPolicy(next: Readonly<{ passwordLoginEnabled: boolean; registrationEnabled: boolean }>): Promise<AdminSignInOutcome>;
    test(method: AuthSignInMethod): Promise<AdminSignInOutcome>;
  }>;
  state: Readonly<{
    /** The method or `policy` with a request in flight. */
    busy: AuthSignInMethod | "policy" | null;
    error: string | null;
    loaded: boolean;
    overview: AdminSignInOverview | null;
  }>;
}>;

export type AdminSignInControllerOptions = Readonly<{
  active: boolean;
  onNotice(message: string): void;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>;

const CONFLICTS = new Set(["sign_in_active_conflict", "sign_in_draft_conflict", "sign_in_policy_conflict"]);

/**
 * The one state owner of the Sign-in page: the overview the server returned last and the one
 * request in flight. Each mutation replaces the method or policy with the server's answer.
 */
export function useAdminSignInController({
  active,
  onNotice,
  requestConfirmation
}: AdminSignInControllerOptions): AdminSignInController {
  const [overview, setOverview] = useState<AdminSignInOverview | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<AdminSignInController["state"]["busy"]>(null);
  const overviewRef = useRef<AdminSignInOverview | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const replace = useCallback((next: AdminSignInOverview) => {
    overviewRef.current = next;
    setOverview(next);
  }, []);

  const replaceMethod = useCallback((method: AdminSignInMethodState) => {
    const current = overviewRef.current;
    if (!current) return;
    replace({ ...current, methods: current.methods.map((entry) => entry.method === method.method ? method : entry) });
  }, [replace]);

  const apply = useCallback((result: Awaited<ReturnType<typeof requestAdminSignIn>>) => {
    setLoaded(true);
    if (result.ok) {
      setError(null);
      replace(result.data);
    } else {
      setError(adminSignInErrorMessage(result.error));
    }
  }, [replace]);

  // The first load applies the answer from the response callback; a later refresh awaits it.
  useEffect(() => {
    if (!active) return;
    const generation = ++generationRef.current;
    void requestAdminSignIn().then((result) => {
      if (!mountedRef.current || generation !== generationRef.current) return;
      apply(result);
    });
  }, [active, apply]);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    const result = await requestAdminSignIn();
    if (!mountedRef.current || generation !== generationRef.current) return;
    apply(result);
  }, [apply]);

  const guard = useCallback(async (
    key: AuthSignInMethod | "policy",
    operation: () => Promise<AdminSignInOutcome>
  ): Promise<AdminSignInOutcome> => {
    if (busyRef.current) return { message: "", ok: false };
    busyRef.current = true;
    ++generationRef.current;
    setBusy(key);
    try {
      return await operation();
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  }, []);

  const failed = useCallback((code: string): AdminSignInOutcome => {
    if (CONFLICTS.has(code)) void load();
    return { message: adminSignInErrorMessage(code), ok: false };
  }, [load]);

  const methodState = useCallback((method: AuthSignInMethod) =>
    overviewRef.current?.methods.find((entry) => entry.method === method) ?? null, []);

  /** One activation request; a changed identity source comes back for confirmation. */
  const activateOnce = useCallback((
    method: AuthSignInMethod,
    confirmSourceChange: boolean
  ): Promise<AdminSignInOutcome | Readonly<{ affectedIdentities: number; ok: "confirm" }>> => {
    let pendingConfirmation: Readonly<{ affectedIdentities: number; ok: "confirm" }> | null = null;
    return guard(method, async () => {
      const current = methodState(method);
      if (!current) return failed("sign_in_method_unavailable");
      const result = await runAdminSignInMethodAction(method, {
        action: "activate",
        ...(confirmSourceChange ? { confirmSourceChange: true as const } : {}),
        expectedActiveVersion: current.active.version,
        expectedDraftVersion: current.draft.version
      });
      if (!mountedRef.current) return { message: "", ok: false };
      if (result.ok) {
        replaceMethod(result.data.method);
        onNotice(`${signInMethodLabels[method]} sign-in is active.`);
        return { ok: true };
      }
      if (result.error === "sign_in_source_changed" && !confirmSourceChange) {
        pendingConfirmation = { affectedIdentities: result.affectedIdentities ?? 0, ok: "confirm" };
        return { message: "", ok: false };
      }
      return failed(result.error);
    }).then((outcome) => pendingConfirmation ?? outcome);
  }, [failed, guard, methodState, onNotice, replaceMethod]);

  const actions = useMemo<AdminSignInController["actions"]>(() => ({
    activate: async (method) => {
      const outcome = await activateOnce(method, false);
      if (outcome.ok !== "confirm") return outcome;
      const label = signInMethodLabels[method];
      const count = outcome.affectedIdentities;
      requestConfirmation({
        body: `${count} ${count === 1 ? "account signed in" : "accounts signed in"} through the previous ${label} source. ` +
          `They stop signing in with ${label} until an administrator unlinks the old identity on each user's page; ` +
          "the next sign-in then links again under the email rules.",
        confirmLabel: "Activate anyway",
        dialogLabel: `Activate ${label} with a new source`,
        onConfirm: async () => {
          const confirmed = await activateOnce(method, true);
          if (confirmed.ok === false && confirmed.message) onNotice(confirmed.message);
        },
        testId: "admin-confirm-sign-in-source-change",
        title: "The identity source changes",
        tone: "warning"
      });
      return { message: "Activation waits for your confirmation.", ok: false };
    },

    refresh: load,

    requestDisable: (method) => {
      const label = signInMethodLabels[method];
      const current = methodState(method);
      requestConfirmation({
        body: current?.environmentConfigured
          ? `${label} sign-in goes back to the configuration in the environment variables. The settings here are kept.`
          : `People can no longer sign in with ${label}. The settings are kept, so you can activate them again later.`,
        confirmLabel: "Disable",
        dialogLabel: `Disable ${label} sign-in`,
        onConfirm: async () => {
          await guard(method, async () => {
            const latest = methodState(method);
            if (!latest) return failed("sign_in_method_unavailable");
            const result = await runAdminSignInMethodAction(method, {
              action: "disable",
              expectedActiveVersion: latest.active.version
            });
            if (!mountedRef.current) return { message: "", ok: false };
            if (!result.ok) {
              const outcome = failed(result.error);
              if (!outcome.ok) onNotice(outcome.message);
              return outcome;
            }
            replaceMethod(result.data.method);
            onNotice(`${label} sign-in is off in the admin panel.`);
            return { ok: true };
          });
        },
        testId: "admin-confirm-sign-in-disable",
        title: `Disable ${label} sign-in?`,
        tone: "warning"
      });
    },

    saveDraft: (method, draft) => guard(method, async () => {
      const current = methodState(method);
      if (!current) return failed("sign_in_method_unavailable");
      const result = await saveAdminSignInDraft(method, {
        config: draft.config,
        expectedDraftVersion: current.draft.version,
        secretActions: draft.secretActions
      });
      if (!mountedRef.current) return { message: "", ok: false };
      if (!result.ok) return failed(result.error);
      replaceMethod(result.data.method);
      return { ok: true };
    }),

    setPolicy: (next) => guard("policy", async () => {
      const current = overviewRef.current;
      if (!current) return failed("sign_in_admin_action_failed");
      const result = await saveAdminSignInPolicy({ ...next, expectedVersion: current.policy.version });
      if (!mountedRef.current) return { message: "", ok: false };
      if (!result.ok) return failed(result.error);
      const latest = overviewRef.current;
      if (latest) replace({ ...latest, policy: result.data.policy });
      onNotice("Sign-in switches saved.");
      return { ok: true };
    }),

    test: (method) => guard(method, async () => {
      const current = methodState(method);
      if (!current) return failed("sign_in_method_unavailable");
      const result = await testAdminSignInMethod(method, { action: "test", expectedDraftVersion: current.draft.version });
      if (!mountedRef.current) return { message: "", ok: false };
      if (!result.ok) return failed(result.error);
      replaceMethod(result.data.method);
      return result.data.test.passed ? { ok: true } : { message: signInTestMessage(result.data.test.code), ok: false };
    })
  }), [activateOnce, failed, guard, load, methodState, onNotice, replace, replaceMethod, requestConfirmation]);

  return useMemo(() => ({
    actions,
    state: { busy, error, loaded, overview }
  }), [actions, busy, error, loaded, overview]);
}
