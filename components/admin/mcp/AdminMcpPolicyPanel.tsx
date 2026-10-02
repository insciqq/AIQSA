"use client";

import {
  adminMcpPolicyErrorMessage,
  getAdminMcpPolicy,
  updateAdminMcpPolicy
} from "@/components/admin/adminMcpPolicyApi";
import { cardClass, sectionHeadingClass } from "@/components/admin/mcp/mcpPrimitives";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import { UiV2Button, UiV2Switch } from "@/components/ui-v2";
import type { McpPolicyWire } from "@/lib/contracts/mcpPolicy";
import { useCallback, useEffect, useId, useRef, useState } from "react";

const SWITCH_LABEL = "Allow personal connections to the local network";

/**
 * Installation-wide switch for personal MCP: whether people's own
 * connections may reach this network and the AIQSA host. AIQSA's services
 * and cloud metadata stay blocked either way.
 */
export function AdminMcpPolicyPanel({ reportNotice }: Readonly<{
  reportNotice: AdminFeedbackController["reportNotice"];
}>) {
  const headingId = useId();
  const descriptionId = useId();
  const [policy, setPolicy] = useState<McpPolicyWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const mounted = useRef(false);
  const readGeneration = useRef(0);
  const updating = useRef(false);

  const load = useCallback(async () => {
    const generation = ++readGeneration.current;
    const result = await getAdminMcpPolicy();
    if (!mounted.current || generation !== readGeneration.current) return;
    setLoading(false);
    if (result.ok) {
      setPolicy(result.data);
      setReadError(null);
    } else {
      setReadError(adminMcpPolicyErrorMessage(result.error, "read"));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => { void load(); });
    return () => {
      mounted.current = false;
      readGeneration.current += 1;
    };
  }, [load]);

  async function update(personalLocalNetworkEnabled: boolean) {
    if (!policy || updating.current) return;
    updating.current = true;
    // A read still in flight must not overwrite the committed answer.
    readGeneration.current += 1;
    setBusy(true);
    setUpdateError(null);
    const result = await updateAdminMcpPolicy({ personalLocalNetworkEnabled, version: policy.version });
    updating.current = false;
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      setPolicy(result.data);
      reportNotice(result.data.personalLocalNetworkEnabled
        ? "Personal connections can reach the local network."
        : "Personal connections can no longer reach the local network.");
      return;
    }
    setUpdateError(adminMcpPolicyErrorMessage(result.error));
    if (result.error === "mcp_policy_stale") void load();
  }

  return (
    <section aria-labelledby={headingId} className={`${cardClass} px-5 py-1`} data-testid="admin-mcp-policy">
      <h2 className={`${sectionHeadingClass} pt-4`} id={headingId}>Personal connections</h2>
      {policy ? (
        <div className="flex min-w-0 items-center justify-between gap-6 py-4">
          <span className="min-w-0">
            <strong className="block text-sm font-medium text-ink">{SWITCH_LABEL}</strong>
            <span className="mt-1 block max-w-2xl text-xs leading-5 text-ink-muted" id={descriptionId}>
              On by default. People can connect their own MCP servers on this network and on the AIQSA host;
              AIQSA&apos;s services and cloud metadata always stay blocked. While this is on, anyone who can add a
              personal connection can send requests to devices on this network. Turning it off stops local
              connections, including in chats already running.
            </span>
          </span>
          <UiV2Switch
            aria-describedby={descriptionId}
            checked={policy.personalLocalNetworkEnabled}
            className="shrink-0"
            disabled={busy}
            label={SWITCH_LABEL}
            onChange={(next) => void update(next)}
          />
        </div>
      ) : loading ? (
        <p className="py-4 text-sm text-ink-muted" role="status">Loading personal connection settings…</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3 py-4" role="alert">
          <p className="min-w-0 flex-1 text-sm text-ink">{readError}</p>
          <UiV2Button onClick={() => { setLoading(true); void load(); }} tone="ghost" type="button">Try again</UiV2Button>
        </div>
      )}
      {policy && (updateError ?? readError) ? (
        <p className="mb-4 border-l-2 border-critical bg-critical/10 px-3 py-2 text-xs text-critical" role="alert">
          {updateError ?? readError}
        </p>
      ) : null}
    </section>
  );
}
