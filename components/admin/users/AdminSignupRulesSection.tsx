"use client";

import { useAdminSectionTopbar, type AdminShellTopbar } from "@/components/admin/AdminShell";
import { groupLabel } from "@/components/admin/adminViewUtils";
import type { AdminAccessRulesController } from "@/components/admin/useAdminAccessRulesController";
import { AdminSignupRulesSheet } from "@/components/admin/users/AdminSignupRulesSheet";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
import type { AdminAccessRuleRecord, AdminGroup } from "@/lib/contracts/admin";
import { Globe2, Mail } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export function AdminSignupRulesSection({ controller, groups }: Readonly<{
  controller: AdminAccessRulesController;
  groups: readonly AdminGroup[];
}>) {
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<AdminAccessRuleRecord | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const restoreAddFocus = useRef(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const busy = controller.actionsDisabled || deletingBusy;
  const restorePendingFocus = useCallback((button: HTMLButtonElement | null) => {
    if (busy || !restoreAddFocus.current || !button || button.disabled) return;
    button.focus();
    if (document.activeElement === button) restoreAddFocus.current = false;
  }, [busy]);
  const setAddRef = useCallback((button: HTMLButtonElement | null) => {
    addRef.current = button;
    // The topbar commits separately; keep the request until its button is ready.
    restorePendingFocus(button);
  }, [restorePendingFocus]);
  const topbar = useMemo<AdminShellTopbar>(() => ({
    title: "Sign-up rules",
    actions: <UiV2Button disabled={busy} icon="plus" onClick={() => setAdding(true)} ref={setAddRef} tone="primary">Add rule</UiV2Button>
  }), [busy, setAddRef]);
  useAdminSectionTopbar(topbar);

  useEffect(() => {
    if (!restoreAddFocus.current || deleting || busy) return;
    const frame = window.requestAnimationFrame(() => {
      restorePendingFocus(addRef.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [busy, deleting, restorePendingFocus]);

  const confirmDelete = async () => {
    if (!deleting || busy) return;
    setDeletingBusy(true);
    const ok = await controller.actions.deleteRule(deleting);
    if (ok) restoreAddFocus.current = true;
    setDeletingBusy(false);
    setDeleting(null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
      <div className="max-w-3xl space-y-2 text-sm leading-6 text-ink-muted">
        <p>Registrations with a matching verified email address or domain are automatically approved and receive the rule’s groups. Other registrations wait for approval.</p>
        <p>Use an exact domain such as <span className="font-mono text-ink">example.com</span>. Rule changes do not disable active accounts or grant administrator access.</p>
      </div>
      <section aria-label="Saved sign-up rules" className="min-w-0">
        <h2 className="mb-3 text-sm font-semibold text-ink">Rules · {controller.rules.length}</h2>
        {controller.rules.length ? (
          <ul aria-label="Sign-up rules" className="divide-y divide-trace-subtle border-y border-trace-subtle">
            {controller.rules.map((rule) => {
              const Icon = rule.kind === "email" ? Mail : Globe2;
              return (
                <li className="flex min-w-0 items-center gap-3 py-3" data-testid="admin-signup-rule" key={rule.id}>
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink [overflow-wrap:anywhere]">{rule.value}</p>
                    <p className="text-xs leading-5 text-ink-muted [overflow-wrap:anywhere]">
                      {rule.kind === "email" ? "Email" : "Domain"} · {groupLabel(rule.defaultGroups)} · {rule.enabled ? "Enabled" : "Disabled"}
                    </p>
                  </div>
                  <UiV2IconButton disabled={busy} icon="trash" label={`Delete rule ${rule.value}`} onClick={() => setDeleting(rule)} tooltip="Delete" />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted" role="status">No rules yet. Every sign-up waits for approval. Add a rule to approve matching registrations automatically.</p>
        )}
      </section>
      <AdminSignupRulesSheet controller={controller} groups={groups} onClose={() => setAdding(false)} open={adding} />
      {deleting ? (
        <ConfirmationDialog
          busy={deletingBusy} confirmLabel="Delete rule" dialogLabel={`Delete sign-up rule ${deleting.value}`} icon="trash"
          onCancel={() => setDeleting(null)} onConfirm={() => void confirmDelete()}
          testId="admin-confirm-delete-access-rule" title="Delete sign-up rule?"
        >
          {`Delete the ${deleting.kind} rule for ${deleting.value}? Future registrations that match no other rule will wait for approval. Active accounts keep their access.`}
        </ConfirmationDialog>
      ) : null}
    </div>
  );
}
