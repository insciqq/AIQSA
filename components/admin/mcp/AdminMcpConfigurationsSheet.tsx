"use client";

import { UiV2Sheet } from "@/components/ui-v2/SheetV2";
import {
  AdminMcpOneTimeValues,
  mcpOneTimeRequest,
  type AdminMcpOneTimeValueDraft
} from "@/components/admin/mcp/AdminMcpOneTimeValues";
import { mcpConfigurationSummary } from "@/components/admin/mcp/mcpServerView";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminMcpServer } from "@/lib/contracts/mcp";

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
    <UiV2Sheet
      closeBlocked={controller.state.busy}
      description="Restore switches back to a configuration as it was checked. Rebuild and apply checks it with the server again, then applies it."
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
              return (
                <li className="grid gap-2.5 px-4 py-3" data-testid={`mcp-configuration-${configuration.id}`} key={configuration.id}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">
                      Configuration {configuration.revisionNumber}{current ? " · Current" : ""}
                    </p>
                    <p className="text-xs leading-5 text-ink-muted">{mcpConfigurationSummary(configuration)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {!current ? (
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
    </UiV2Sheet>
  );
}
