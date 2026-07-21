import {
  AdminGroupOptions,
  AdminTableRegion,
  dangerButton,
  inputClass,
  primaryButton
} from "@/components/admin/adminPrimitives";
import { groupLabel } from "@/components/admin/adminViewUtils";
import type { AdminAccessRuleKind, AdminAccessRuleRecord, AdminGroup } from "@/lib/contracts/admin";
import { Check, Globe2, Mail, Search, Trash2 } from "lucide-react";

export type AdminAccessRuleActionTarget = Pick<AdminAccessRuleRecord, "id" | "kind" | "value">;

export type AdminAccessRulesSectionData = Readonly<{
  groups: AdminGroup[];
  rules: AdminAccessRuleRecord[];
  totalRuleCount: number;
}>;

export type AdminAccessRulesSectionState = Readonly<{
  formOpen: boolean;
  groupIds: string[];
  kind: AdminAccessRuleKind;
  normalizedPreview: string;
  query: string;
  value: string;
  valueError: string | null;
}>;

export type AdminAccessRulesSectionStatus = Readonly<{
  actionsDisabled: boolean;
}>;

export type AdminAccessRulesSectionActions = Readonly<{
  changeGroups(groupIds: string[]): void;
  changeKind(kind: AdminAccessRuleKind): void;
  changeQuery(value: string): void;
  changeValue(value: string): void;
  createRule(): Promise<void> | void;
  requestDeleteRule(rule: AdminAccessRuleActionTarget): void;
}>;

export type AdminAccessRulesSectionProps = Readonly<{
  actions: AdminAccessRulesSectionActions;
  data: AdminAccessRulesSectionData;
  state: AdminAccessRulesSectionState;
  status: AdminAccessRulesSectionStatus;
}>;

export function AdminAccessRulesSection({ actions, data, state, status }: AdminAccessRulesSectionProps) {
  return (
    <>
      {state.formOpen ? (
        <form
          className="grid gap-3 border-b border-separator-subtle bg-surface-raised/40 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void actions.createRule();
          }}
        >
          <div className="grid gap-2 lg:grid-cols-[160px_minmax(0,1fr)]">
            <label className="text-xs font-medium text-content-secondary self-center" htmlFor="rule-kind">
              Kind
            </label>
            <select
              className={inputClass}
              id="rule-kind"
              onChange={(event) => actions.changeKind(event.currentTarget.value as AdminAccessRuleKind)}
              value={state.kind}
            >
              <option value="email">Email</option>
              <option value="domain">Domain</option>
            </select>
            <label className="text-xs font-medium text-content-secondary self-center" htmlFor="rule-value">
              Value
            </label>
            <input
              aria-describedby={state.valueError ? "rule-value-error" : undefined}
              aria-invalid={state.valueError ? true : undefined}
              className={inputClass}
              id="rule-value"
              onChange={(event) => actions.changeValue(event.currentTarget.value)}
              placeholder={state.kind === "email" ? "person@example.com" : "example.com"}
              value={state.value}
            />
            {state.valueError ? (
              <p className="text-xs text-accent-rose lg:col-start-2" id="rule-value-error">
                {state.valueError}
              </p>
            ) : null}
          </div>
          <AdminGroupOptions
            groups={data.groups}
            label="Default groups"
            onChange={actions.changeGroups}
            selected={state.groupIds}
          />
          <div className="rounded-control border border-separator-subtle bg-surface-thread px-3 py-2 text-xs text-content-secondary">
            <div className="text-xs font-medium text-content-secondary mb-1">Match preview</div>
            {state.normalizedPreview ? (
              <p className="break-words [overflow-wrap:anywhere]">
                Future verified access requests must match the exact {state.kind}{" "}
                <span className="break-words font-mono text-content-primary [overflow-wrap:anywhere]">
                  {state.normalizedPreview}
                </span>
                . Matching users receive{" "}
                {state.groupIds.length
                  ? `${state.groupIds.length} default group${state.groupIds.length === 1 ? "" : "s"}`
                  : "no default groups"}
                .
              </p>
            ) : (
              <p>Enter a value to preview the exact normalized match before saving.</p>
            )}
          </div>
          <div className="rounded-panel bg-surface-raised/50 px-3 py-2 text-xs text-content-muted">
            Access rules are durable approval policy. One-off invites remain separate and are managed in Invites.
          </div>
          <div>
            <button className={primaryButton} disabled={status.actionsDisabled} type="submit">
              <Check className="size-3.5" aria-hidden="true" />
              Save rule
            </button>
          </div>
        </form>
      ) : null}

      <div className="flex items-center gap-2 border-b border-separator-subtle bg-surface-raised/40 px-3 py-2">
        <div className="flex min-h-control-sm min-w-0 flex-1 items-center gap-2 rounded-control border border-separator-subtle bg-surface-thread px-3 focus-within:ring-2 focus-within:ring-accent-cyan/55 [@media(hover:none)]:!min-h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!min-h-touch [@media(pointer:coarse)]:!min-w-touch">
          <Search className="size-3.5 shrink-0 text-content-muted" aria-hidden="true" />
          <input
            aria-label="Search access rules"
            className="min-h-control-sm min-w-0 flex-1 bg-transparent text-xs [@media(hover:none)]:!min-h-touch [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!min-h-touch [@media(pointer:coarse)]:!min-w-touch text-content-primary outline-none placeholder:text-content-disabled"
            onChange={(event) => actions.changeQuery(event.currentTarget.value)}
            placeholder="Search exact emails, domains, or default groups"
            value={state.query}
          />
        </div>
      </div>

      <AdminTableRegion label="Access rules table">
        <table className="w-full min-w-[760px] border-collapse text-left text-xs">
          <thead className="bg-surface-thread text-content-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Rule</th>
              <th className="px-3 py-2 font-medium">Default groups</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.rules.length ? (
              data.rules.map((rule) => (
                <tr className="border-b border-separator-subtle align-top last:border-b-0" key={rule.id}>
                  <td className="px-3 py-3">
                    <div className="flex min-w-0 items-center gap-2 text-content-primary">
                      {rule.kind === "email" ? (
                        <Mail className="size-3.5 shrink-0 text-accent-cyan" aria-hidden="true" />
                      ) : (
                        <Globe2 className="size-3.5 shrink-0 text-accent-cyan" aria-hidden="true" />
                      )}
                      <span className="break-words [overflow-wrap:anywhere]">{rule.value}</span>
                    </div>
                    <div className="mt-1 text-content-muted">Exact {rule.kind} match</div>
                  </td>
                  <td className="px-3 py-3 text-content-secondary">{groupLabel(rule.defaultGroups)}</td>
                  <td className="px-3 py-3">
                    <button
                      className={dangerButton}
                      disabled={status.actionsDisabled}
                      onClick={() =>
                        actions.requestDeleteRule({
                          id: rule.id,
                          kind: rule.kind,
                          value: rule.value
                        })
                      }
                      title="Delete access rule"
                      type="button"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-3 py-8 text-center text-content-muted" colSpan={3}>
                  {data.totalRuleCount ? "No access rules match this view" : "No access rules"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </AdminTableRegion>
    </>
  );
}
