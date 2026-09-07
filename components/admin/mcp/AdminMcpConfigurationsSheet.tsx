"use client";

import { AdminSheet } from "@/components/admin/AdminSheet";
import {
  AdminMcpOneTimeValues,
  mcpOneTimeRequest,
  type AdminMcpOneTimeValueDraft
} from "@/components/admin/mcp/AdminMcpOneTimeValues";
import { McpStatusPill } from "@/components/admin/mcp/mcpPrimitives";
import { mcpConfigurationBuild, mcpConfigurationSummary } from "@/components/admin/mcp/mcpServerView";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminMcpServer } from "@/lib/contracts/mcp";

/**
 * Earlier configurations (PRD 5.10): every configuration that was applied
 * before, with Restore for a saved build and Rebuild for one that has to be
 * built again. Both close the sheet once the server answered.
 */
export function AdminMcpConfigurationsSheet({
  controller,
  onClose,
  oneTimeValues,
  open,
  server,
  setOneTimeValues
}: Readonly<{
  controller: AdminMcpController;
  onClose(): void;
  oneTimeValues: AdminMcpOneTimeValueDraft;
  open: boolean;
  server: AdminMcpServer;
  setOneTimeValues(values: AdminMcpOneTimeValueDraft): void;
}>) {
  if (!open) return null;
  const configurations = [...server.revisions].sort((left, right) => right.revisionNumber - left.revisionNumber);
  const locked = controller.state.busy || Boolean(server.archivedAt);

  const restore = async (revisionId: string) => {
    if (await controller.actions.rollback(server.id, { revisionId })) onClose();
  };
  const rebuild = async (revisionId: string) => {
    const ok = await controller.actions.rebuild(server.id, {
      oneTimeValues: mcpOneTimeRequest(server, oneTimeValues),
      replaceDraft: true,
      revisionId
    });
    setOneTimeValues({});
    if (ok) onClose();
  };

  return (
    <AdminSheet
      closeBlocked={controller.state.busy}
      description="Restore puts a saved build back as it was. Rebuild replaces the current settings with that configuration, builds it again, checks it and applies the result."
      onClose={onClose}
      open
      testId="mcp-configurations-sheet"
      title="Earlier configurations"
    >
      <div className="flex flex-col gap-4">
        <AdminMcpOneTimeValues
          disabled={controller.state.busy}
          onChange={setOneTimeValues}
          server={server}
          values={oneTimeValues}
        />
        {configurations.length ? (
          <ul aria-label="Earlier configurations" className="divide-y divide-trace-subtle rounded-[12px] border border-trace-subtle">
            {configurations.map((configuration) => {
              const current = configuration.id === server.activeRevision?.id;
              const build = mcpConfigurationBuild(configuration);
              return (
                <li className="grid gap-2.5 px-4 py-3" data-testid={`mcp-configuration-${configuration.id}`} key={configuration.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">
                        Configuration {configuration.revisionNumber}{current ? " · Current" : ""}
                      </p>
                      <p className="text-xs leading-5 text-ink-muted">{mcpConfigurationSummary(configuration)}</p>
                    </div>
                    <McpStatusPill label={build.label} testId="mcp-configuration-build" tone={build.tone} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {!current && configuration.artifactStatus !== "missing" ? (
                      <UiV2Button disabled={locked} icon="history" onClick={() => void restore(configuration.id)} tone="ghost" type="button">
                        Restore
                      </UiV2Button>
                    ) : null}
                    <UiV2Button disabled={locked} icon="regenerate" onClick={() => void rebuild(configuration.id)} tone="ghost" type="button">
                      Rebuild and apply
                    </UiV2Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-[12px] border border-trace-subtle px-4 py-6 text-center text-sm text-ink-muted" role="status">
            No earlier configurations yet. Each Test &amp; Save that applies settings adds one.
          </p>
        )}
      </div>
    </AdminSheet>
  );
}
