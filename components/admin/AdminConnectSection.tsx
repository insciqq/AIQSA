"use client";

import {
  adminConnectErrorMessage,
  getAdminConnectPolicy,
  updateAdminConnectPolicy
} from "@/components/admin/adminConnectApi";
import { useAdminSectionTopbar } from "@/components/admin/AdminShell";
import { PolicyToggle } from "@/components/admin/AdminWorkspaceSection";
import { cardClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import { UiV2Button } from "@/components/ui-v2";
import { CONNECT_ADMIN_POLICY_CONFLICT_ERROR, type ConnectAdminPolicy } from "@/lib/contracts/connect";
import { useCallback, useEffect, useRef, useState } from "react";

const topbar = { title: "AIQSA Connect" };

export const ADMIN_CONNECT_WARNING =
  "Lets users open terminals on their own computers from AIQSA. The server relays their terminal traffic.";

/** The installation switch of AIQSA Connect; off by default. */
export function AdminConnectSection({ reportNotice }: Readonly<{
  reportNotice: AdminFeedbackController["reportNotice"];
}>) {
  useAdminSectionTopbar(topbar);
  const [policy, setPolicy] = useState<ConnectAdminPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    const result = await getAdminConnectPolicy(undefined, AbortSignal.timeout(10_000));
    if (!mounted.current || current !== generation.current) return;
    setLoading(false);
    if (result.ok) {
      setPolicy(result.data);
      setReadError(null);
    } else {
      if (result.error === "forbidden" || result.error === "unauthorized") setPolicy(null);
      setReadError(adminConnectErrorMessage(result.error));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => { void refresh(); });
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [refresh]);

  async function update(enabled: boolean) {
    if (!policy || busy) return;
    generation.current += 1;
    setBusy(true);
    setError(null);
    const result = await updateAdminConnectPolicy({ enabled, expectedVersion: policy.version });
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      setPolicy(result.data);
      reportNotice(result.data.enabled ? "AIQSA Connect turned on." : "AIQSA Connect turned off.");
      return;
    }
    setError(adminConnectErrorMessage(result.error));
    if (result.error === CONNECT_ADMIN_POLICY_CONFLICT_ERROR) void refresh();
  }

  return (
    <section aria-label="AIQSA Connect policy" className="flex max-w-[1120px] min-w-0 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <p className="max-w-2xl text-sm leading-6 text-ink-secondary">
        Remote terminals for Claude Code, Codex and shells running on users&apos; own computers.
      </p>
      {error ? <p className="border-l-2 border-critical bg-critical/10 px-3 py-2 text-xs text-critical" role="alert">{error}</p> : null}
      {readError ? <p className="text-xs leading-5 text-critical" role="alert">{readError}</p> : null}
      {policy ? (
        <div className={`${cardClass} px-5 py-1`}>
          <h2 className={`${sectionHeadingClass} pt-4`}>Access</h2>
          <PolicyToggle
            checked={policy.enabled}
            description={ADMIN_CONNECT_WARNING}
            disabled={busy}
            label="Enable AIQSA Connect"
            onChange={(enabled) => void update(enabled)}
          />
          <p className="border-t border-trace-subtle py-4 text-xs leading-5 text-ink-muted">
            Off by default. Turning it off hides the mode, disconnects every computer and stops serving the client download.
          </p>
        </div>
      ) : loading ? (
        <p className="text-sm text-ink-muted" role="status">Loading the AIQSA Connect setting…</p>
      ) : (
        <UiV2Button className="self-start" onClick={() => void refresh()} tone="ghost">Try again</UiV2Button>
      )}
    </section>
  );
}
