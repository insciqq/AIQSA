import { MCP_RUN_PLAN_LIMITS } from "@/lib/contracts/mcp";
import { CircleAlert, LoaderCircle, Wrench } from "lucide-react";
import { useEffect } from "react";
import { refreshMcpSettings, useMcpSettingsStore } from "./mcpSettingsStore";

export function McpComposerSummary({
  onOpenSettings
}: Readonly<{
  onOpenSettings(): void;
}>) {
  const loadState = useMcpSettingsStore((state) => state.loadState);
  const servers = useMcpSettingsStore((state) => state.servers);

  useEffect(() => {
    void refreshMcpSettings().catch(() => undefined);
    const refreshVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshMcpSettings(true).catch(() => undefined);
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
  const readyTools = ready.reduce((count, server) => count + server.tools.length, 0);
  const issues = enabled.length - ready.length;
  const knownToolCount = enabled.reduce((count, server) => count + server.knownToolCount, 0);
  const overToolLimit = knownToolCount > MCP_RUN_PLAN_LIMITS.maxTools;

  if (servers.length === 0) return null;

  const label = enabled.length === 0
        ? "MCP tools are off"
        : `${ready.length}/${enabled.length} MCP ready · ${readyTools} tool${readyTools === 1 ? "" : "s"}`;

  return (
    <button
      className="mt-2 flex min-h-touch w-full items-center gap-2 rounded-control px-3 text-left text-xs text-content-secondary outline-none hover:bg-surface-hover hover:text-content-primary focus-visible:ring-2 focus-visible:ring-accent-cyan/55 sm:min-h-control [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch"
      data-testid="composer-mcp-summary"
      onClick={onOpenSettings}
      type="button"
    >
      {loadState === "loading" ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-accent-cyan" aria-hidden="true" />
      ) : issues > 0 || overToolLimit || loadState === "error" ? (
        <CircleAlert className="size-3.5 shrink-0 text-accent-amber" aria-hidden="true" />
      ) : (
        <Wrench className="size-3.5 shrink-0 text-content-muted" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 break-words">{label}</span>
      {issues > 0 ? <span className="shrink-0 font-medium text-accent-amber">{issues} need attention</span> : null}
      {overToolLimit ? <span className="shrink-0 font-medium text-accent-amber">Tool limit exceeded</span> : null}
      <span className="shrink-0 font-medium text-content-primary">Manage</span>
    </button>
  );
}
