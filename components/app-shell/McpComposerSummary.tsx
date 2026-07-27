import { MCP_RUN_PLAN_LIMITS } from "@/lib/contracts/mcp";
import { CircleAlert, LoaderCircle, Wrench } from "lucide-react";
import { useEffect } from "react";
import { mcpReadinessPresentation } from "./mcpReadiness";
import { refreshMcpSettings, useMcpSettingsStore } from "./mcpSettingsStore";

function attentionLabel(input: {
  authorization: number;
  counted: boolean;
  failed: number;
  setup: number;
}): string {
  const total = input.authorization + input.failed + input.setup;
  if (input.failed === total) {
    if (!input.counted && total === 1) return "Activation failed";
    return `${total} activation${total === 1 ? "" : "s"} failed`;
  }
  if (input.setup === total) {
    if (!input.counted && total === 1) return "Needs setup";
    return `${total} ${total === 1 ? "needs" : "need"} setup`;
  }
  if (input.authorization === total) {
    if (!input.counted && total === 1) return "Needs authorization";
    return `${total} ${total === 1 ? "needs" : "need"} authorization`;
  }
  if (!input.counted) return "Needs attention";
  return `${total} need attention`;
}

export function McpComposerSummary({
  onOpenSettings,
  toolCallingSupported = true
}: Readonly<{
  onOpenSettings(): void;
  toolCallingSupported?: boolean;
}>) {
  const loadState = useMcpSettingsStore((state) => state.loadState);
  const servers = useMcpSettingsStore((state) => state.servers);

  useEffect(() => {
    void refreshMcpSettings().catch(() => undefined);
    const refreshVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshMcpSettings(true, { background: true }).catch(() => undefined);
      }
    };
    const timer = window.setInterval(refreshVisible, 15_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, []);

  const enabled = servers.filter((server) => server.enabled);
  const ready = enabled.filter((server) => server.readiness === "ready");
  const activating = enabled.filter((server) =>
    mcpReadinessPresentation(server.readiness).kind === "progress");
  const setupCount = enabled.filter((server) => server.readiness === "needs_setup").length;
  const authorizationCount = enabled.filter((server) =>
    server.readiness === "needs_authorization" || server.readiness === "reauthorization_required").length;
  const failedCount = enabled.filter((server) =>
    mcpReadinessPresentation(server.readiness).kind === "failed").length;
  const attentionCount = setupCount + authorizationCount + failedCount;
  const readyTools = ready.reduce((count, server) => count + server.tools.length, 0);
  const knownToolCount = enabled.reduce((count, server) => count + server.knownToolCount, 0);
  const overToolLimit = knownToolCount > MCP_RUN_PLAN_LIMITS.maxTools;

  const label = !toolCallingSupported
    ? "Not supported by this model"
    : loadState === "loading" && servers.length === 0
    ? "Loading…"
    : loadState === "error" && servers.length === 0
      ? "Unavailable"
      : servers.length === 0
        ? "Not configured"
        : enabled.length === 0
          ? "Disabled"
          : `${ready.length}/${enabled.length} ready · ${readyTools} tool${readyTools === 1 ? "" : "s"}`;

  const lifecycleLabel = !toolCallingSupported
    ? "Not supported by this model"
    : loadState === "loading" && servers.length === 0
    ? "Loading…"
    : loadState === "error" && servers.length === 0
      ? "Unavailable"
      : servers.length === 0
        ? "Not configured"
        : enabled.length === 0
          ? "Disabled"
          : "Enabled";
  const primaryRunLabel = !toolCallingSupported || enabled.length === 0
    ? null
    : attentionCount > 0
      ? attentionLabel({
          authorization: authorizationCount,
          counted: false,
          failed: failedCount,
          setup: setupCount
        })
      : activating.length > 0
        ? "Activating"
        : readyTools > 0
          ? `${readyTools} tool${readyTools === 1 ? "" : "s"} ready`
          : "0 tools ready";
  const activatingDetail = toolCallingSupported && activating.length > 0 && primaryRunLabel !== "Activating"
    ? `${activating.length} activating`
    : null;
  const lifecycleTone = toolCallingSupported && loadState === "error" && servers.length === 0
    ? "text-critical"
    : "text-ink-muted";
  const runTruthTone = failedCount > 0
    ? "text-critical"
    : attentionCount > 0
      ? "text-caution"
      : activating.length > 0
        ? "text-proof"
        : "text-ink-muted";
  const titleParts = [label];
  if (toolCallingSupported && activating.length > 0) titleParts.push(`${activating.length} activating`);
  if (toolCallingSupported && setupCount > 0) {
    titleParts.push(`${setupCount} ${setupCount === 1 ? "needs" : "need"} setup`);
  }
  if (toolCallingSupported && authorizationCount > 0) {
    titleParts.push(`${authorizationCount} ${authorizationCount === 1 ? "needs" : "need"} authorization`);
  }
  if (toolCallingSupported && failedCount > 0) {
    titleParts.push(`${failedCount} activation${failedCount === 1 ? "" : "s"} failed`);
  }
  if (toolCallingSupported && overToolLimit) titleParts.push("Tool limit exceeded");

  return (
    <button
      className="inline-flex min-h-touch min-w-0 max-w-36 shrink-0 items-center gap-2 rounded-control px-2 text-left text-xs text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-proof/55 sm:min-h-control sm:max-w-52"
      data-testid="composer-mcp-summary"
      onClick={onOpenSettings}
      type="button"
      title={`Tools. ${titleParts.join(". ")}`}
    >
      {!toolCallingSupported ? (
        <Wrench className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
      ) : loadState === "loading" ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-proof" aria-hidden="true" />
      ) : attentionCount > 0 || overToolLimit || loadState === "error" ? (
        <CircleAlert
          className={`size-3.5 shrink-0 ${failedCount > 0 ? "text-critical" : "text-caution"}`}
          aria-hidden="true"
        />
      ) : activating.length > 0 ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-proof" aria-hidden="true" />
      ) : (
        <Wrench className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
      )}
      <span className="min-w-0 leading-4">
        <span className="block font-medium text-ink">Tools</span>
        <span className="block truncate text-xs">
          <span
            className={lifecycleTone}
            data-resource-availability={toolCallingSupported && servers.length > 0 ? enabled.length > 0 ? "enabled" : "disabled" : undefined}
          >
            {lifecycleLabel}
          </span>
          {primaryRunLabel ? (
            <>
              <span className="text-ink-muted" aria-hidden="true"> · </span>
              <span className={runTruthTone} data-testid="composer-tools-run-truth">{primaryRunLabel}</span>
            </>
          ) : null}
          {activatingDetail ? (
            <>
              <span className="text-ink-muted" aria-hidden="true"> · </span>
              <span className="text-proof">{activatingDetail}</span>
            </>
          ) : null}
        </span>
      </span>
    </button>
  );
}
