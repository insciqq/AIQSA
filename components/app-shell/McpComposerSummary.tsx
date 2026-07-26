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

  const label = loadState === "loading" && servers.length === 0
    ? "Loading…"
    : servers.length === 0
      ? "Not configured"
      : enabled.length === 0
        ? "Off"
        : `${ready.length}/${enabled.length} ready · ${readyTools} tool${readyTools === 1 ? "" : "s"}`;

  return (
    <button
      className="inline-flex min-h-touch min-w-0 shrink items-center gap-2 rounded-control px-2.5 text-left text-xs text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-proof/55 sm:min-h-control"
      data-testid="composer-mcp-summary"
      onClick={onOpenSettings}
      type="button"
      title={`Tools. ${label}${issues > 0 ? `. ${issues} need attention` : ""}${overToolLimit ? ". Tool limit exceeded" : ""}`}
    >
      {loadState === "loading" ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-proof" aria-hidden="true" />
      ) : issues > 0 || overToolLimit || loadState === "error" ? (
        <CircleAlert className="size-3.5 shrink-0 text-caution" aria-hidden="true" />
      ) : (
        <Wrench className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
      )}
      <span className="shrink-0 font-medium text-ink">Tools</span>
    </button>
  );
}
