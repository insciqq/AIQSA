"use client";

import {
  adminModelPolicyErrorMessage,
  getAdminModelPolicy,
  updateAdminToolBudgets
} from "@/components/admin/adminModelPolicyApi";
import {
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import { useAdminDraftProtection } from "@/components/admin/AdminDraftProtection";
import type { AdminModelPolicyCatalog } from "@/lib/contracts/adminModelPolicy";
import {
  MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS,
  MCP_RUN_PLAN_LIMITS
} from "@/lib/contracts/mcp";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

function positiveSafeInteger(value: string): number | null {
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function AdminProviderRunLimitsTask({
  active,
  onMutationCommitted
}: Readonly<{
  active: boolean;
  onMutationCommitted?(): void | Promise<unknown>;
}>) {
  const [catalog, setCatalog] = useState<AdminModelPolicyCatalog | null>(null);
  const [mcpAutoDiscoveryTimeoutSeconds, setMcpAutoDiscoveryTimeoutSeconds] = useState("");
  const [maxMcpToolsPerDiscovery, setMaxMcpToolsPerDiscovery] = useState("");
  const [maxToolCalls, setMaxToolCalls] = useState("");
  const [maxToolRounds, setMaxToolRounds] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const autoLoadAttemptedRef = useRef(false);

  const apply = useCallback((next: AdminModelPolicyCatalog) => {
    setCatalog(next);
    setMcpAutoDiscoveryTimeoutSeconds(String(
      next.policy.mcpAutoDiscoveryTimeoutSeconds
    ));
    setMaxMcpToolsPerDiscovery(String(next.policy.maxMcpToolsPerDiscovery));
    setMaxToolCalls(String(next.policy.maxToolCalls));
    setMaxToolRounds(String(next.policy.maxToolRounds));
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await getAdminModelPolicy();
    setLoading(false);
    if (result.ok) {
      apply(result.data);
      return;
    }
    setError(adminModelPolicyErrorMessage(result.error));
  }, [apply]);

  useEffect(() => {
    if (!active) {
      autoLoadAttemptedRef.current = false;
      return;
    }
    if (catalog || loading || autoLoadAttemptedRef.current) return;
    let disposed = false;
    queueMicrotask(() => {
      if (disposed || autoLoadAttemptedRef.current) return;
      autoLoadAttemptedRef.current = true;
      void refresh();
    });
    return () => {
      disposed = true;
    };
  }, [active, catalog, loading, refresh]);

  const parsedCalls = positiveSafeInteger(maxToolCalls);
  const parsedRounds = positiveSafeInteger(maxToolRounds);
  const parsedDiscoveryTimeout = positiveSafeInteger(mcpAutoDiscoveryTimeoutSeconds);
  const parsedDiscoveryTools = positiveSafeInteger(maxMcpToolsPerDiscovery);
  const dirty = Boolean(catalog) && (
    mcpAutoDiscoveryTimeoutSeconds !==
      String(catalog?.policy.mcpAutoDiscoveryTimeoutSeconds) ||
    maxMcpToolsPerDiscovery !== String(catalog?.policy.maxMcpToolsPerDiscovery) ||
    maxToolCalls !== String(catalog?.policy.maxToolCalls) ||
    maxToolRounds !== String(catalog?.policy.maxToolRounds)
  );
  const requestDraftDiscard = useAdminDraftProtection({
    dirty,
    onDiscard: () => {
      if (catalog) apply(catalog);
    },
    owner: "provider-run-limits-policy",
    pending: dirty && busy
  });

  const save = async () => {
    if (!catalog || busy || parsedCalls === null || parsedRounds === null ||
      parsedDiscoveryTimeout === null ||
      parsedDiscoveryTimeout > MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.maxSeconds ||
      parsedDiscoveryTools === null ||
      parsedDiscoveryTools > MCP_RUN_PLAN_LIMITS.maxTools) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await updateAdminToolBudgets({
      expectedVersion: catalog.policy.version,
      mcpAutoDiscoveryTimeoutSeconds: parsedDiscoveryTimeout,
      maxMcpToolsPerDiscovery: parsedDiscoveryTools,
      maxToolCalls: parsedCalls,
      maxToolRounds: parsedRounds
    });
    setBusy(false);
    if (!result.ok) {
      setError(adminModelPolicyErrorMessage(result.error));
      return;
    }
    apply(result.data);
    setNotice("Tool limits updated.");
    void Promise.resolve(onMutationCommitted?.()).catch(() => undefined);
  };

  return (
    <section className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7" aria-labelledby="provider-run-limits-heading">
      <div className="max-w-3xl">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-trace-subtle pb-4">
          <div>
            <p className="text-metadata font-semibold uppercase tracking-[0.1em] text-ink-muted">Installation policy</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink" id="provider-run-limits-heading">Tool limits</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">
              These limits apply to newly accepted answers. In-progress and recovered answers keep the values they started with.
            </p>
          </div>
          <button
            className={quietButton}
            disabled={loading || busy}
            onClick={() => requestDraftDiscard(() => void refresh())}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {error ? <p className="mt-4 rounded-control bg-critical/10 px-3 py-2 text-xs text-critical" role="alert">{error}</p> : null}
        {notice ? <p className="mt-4 rounded-control bg-positive/10 px-3 py-2 text-xs text-positive" role="status">{notice}</p> : null}

        {catalog ? (
          <div className="mt-5 grid max-w-3xl gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-xs font-medium text-ink-secondary" htmlFor="installation-max-tool-rounds">
                Maximum tool rounds
                <input
                  className={inputClass}
                  disabled={busy || loading}
                  id="installation-max-tool-rounds"
                  inputMode="numeric"
                  min={1}
                  onChange={(event) => setMaxToolRounds(event.currentTarget.value)}
                  step={1}
                  type="number"
                  value={maxToolRounds}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-ink-secondary" htmlFor="installation-max-tool-calls">
                Maximum tool calls
                <input
                  className={inputClass}
                  disabled={busy || loading}
                  id="installation-max-tool-calls"
                  inputMode="numeric"
                  min={1}
                  onChange={(event) => setMaxToolCalls(event.currentTarget.value)}
                  step={1}
                  type="number"
                  value={maxToolCalls}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-ink-secondary" htmlFor="installation-max-mcp-tools-per-discovery">
                Maximum Auto tools per discovery
                <input
                  className={inputClass}
                  disabled={busy || loading}
                  id="installation-max-mcp-tools-per-discovery"
                  inputMode="numeric"
                  max={MCP_RUN_PLAN_LIMITS.maxTools}
                  min={1}
                  onChange={(event) => setMaxMcpToolsPerDiscovery(event.currentTarget.value)}
                  step={1}
                  type="number"
                  value={maxMcpToolsPerDiscovery}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-ink-secondary" htmlFor="installation-mcp-auto-discovery-timeout-seconds">
                Auto discovery timeout (seconds)
                <input
                  className={inputClass}
                  disabled={busy || loading}
                  id="installation-mcp-auto-discovery-timeout-seconds"
                  inputMode="numeric"
                  max={MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.maxSeconds}
                  min={MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.minSeconds}
                  onChange={(event) => setMcpAutoDiscoveryTimeoutSeconds(
                    event.currentTarget.value
                  )}
                  step={1}
                  type="number"
                  value={mcpAutoDiscoveryTimeoutSeconds}
                />
              </label>
            </div>
            <p className="text-xs leading-5 text-ink-muted">
              Round and call limits have no product-defined maximum. Auto discovery may load up to {MCP_RUN_PLAN_LIMITS.maxTools} tools per <code>find_tools</code> invocation and may wait at most {MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.maxSeconds} seconds across routing attempts. Values must be positive whole numbers; each discovery uses one call and its tool round counts toward the round limit.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className={primaryButton}
                disabled={busy || !dirty || parsedCalls === null || parsedRounds === null ||
                  parsedDiscoveryTimeout === null ||
                  parsedDiscoveryTimeout > MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.maxSeconds ||
                  parsedDiscoveryTools === null ||
                  parsedDiscoveryTools > MCP_RUN_PLAN_LIMITS.maxTools}
                onClick={() => void save()}
                type="button"
              >
                Save limits
              </button>
              <span className="text-xs text-ink-muted">Policy version: {catalog.policy.version}.</span>
            </div>
          </div>
        ) : loading ? (
          <p className="mt-5 text-sm text-ink-muted" role="status">Loading tool limits…</p>
        ) : null}
      </div>
    </section>
  );
}
