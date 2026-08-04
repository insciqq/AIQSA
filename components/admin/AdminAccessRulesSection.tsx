import {
  AdminAvailabilityStatus,
  adminAvailabilityRowClass,
  AdminGroupOptions,
  AdminTaskBackButton,
  AdminTaskDetailPane,
  AdminTaskIndexPane,
  AdminTaskWorkspace,
  dangerButton,
  EmptyState,
  inputClass,
  primaryButton,
  quietButton
} from "@/components/admin/adminPrimitives";
import { groupLabel } from "@/components/admin/adminViewUtils";
import type { AdminAccessRuleKind, AdminAccessRuleRecord, AdminGroup } from "@/lib/contracts/admin";
import { Check, Globe2, Mail, Search, Trash2 } from "lucide-react";

export type AdminAccessRuleActionTarget = Pick<AdminAccessRuleRecord, "id" | "kind" | "value">;

export type AdminAccessRulesSectionData = Readonly<{
  groups: AdminGroup[];
  rules: AdminAccessRuleRecord[];
  selectedRule: AdminAccessRuleRecord | null;
  totalRuleCount: number;
}>;

export type AdminAccessRulesSectionState = Readonly<{
  compactDetailOpen: boolean;
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
  backToList(): void;
  changeGroups(groupIds: string[]): void;
  changeKind(kind: AdminAccessRuleKind): void;
  changeQuery(value: string): void;
  changeValue(value: string): void;
  createRule(): Promise<void> | void;
  requestDeleteRule(rule: AdminAccessRuleActionTarget): void;
  selectRule(ruleId: string): void;
}>;

export type AdminAccessRulesSectionProps = Readonly<{
  actions: AdminAccessRulesSectionActions;
  data: AdminAccessRulesSectionData;
  state: AdminAccessRulesSectionState;
  status: AdminAccessRulesSectionStatus;
}>;

function CreateRuleTask({ actions, data, state, status }: AdminAccessRulesSectionProps) {
  return (
    <div className="px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <AdminTaskBackButton label="Back to access rules" onClick={actions.backToList} />
      <div className="max-w-2xl border-b border-trace-subtle pb-5">
        <p className="text-metadata font-semibold uppercase tracking-[0.1em] text-ink-muted">New access rule</p>
        <h3 className="mt-2 text-xl font-semibold tracking-tight text-ink">Approve an exact identity scope</h3>
        <p className="mt-2 text-sm leading-6 text-ink-secondary">
          Rules are durable approval policy. One-off onboarding links remain separate in Invites.
        </p>
      </div>
      <form
        className="mt-5 grid max-w-2xl gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void actions.createRule();
        }}
      >
        <label className="text-xs font-medium text-ink-secondary" htmlFor="rule-kind">
          Kind
          <select
            className={`${inputClass} mt-1.5`}
            id="rule-kind"
            onChange={(event) => actions.changeKind(event.currentTarget.value as AdminAccessRuleKind)}
            value={state.kind}
          >
            <option value="email">Email</option>
            <option value="domain">Domain</option>
          </select>
        </label>
        <div>
          <label className="text-xs font-medium text-ink-secondary" htmlFor="rule-value">Value</label>
          <input
            aria-describedby={state.valueError ? "rule-value-error" : undefined}
            aria-invalid={state.valueError ? true : undefined}
            className={`${inputClass} mt-1.5`}
            id="rule-value"
            onChange={(event) => actions.changeValue(event.currentTarget.value)}
            placeholder={state.kind === "email" ? "person@example.com" : "example.com"}
            value={state.value}
          />
          {state.valueError ? <p className="mt-2 text-xs text-critical" id="rule-value-error">{state.valueError}</p> : null}
        </div>
        <AdminGroupOptions groups={data.groups} label="Default groups" onChange={actions.changeGroups} selected={state.groupIds} />
        <div className="border-l border-trace-strong pl-3 text-xs leading-5 text-ink-secondary">
          <p className="font-medium text-ink">Match preview</p>
          {state.normalizedPreview ? (
            <p className="mt-1 break-words [overflow-wrap:anywhere]">
              Future verified access requests must match the exact {state.kind}{" "}
              <span className="break-words font-mono text-ink [overflow-wrap:anywhere]">{state.normalizedPreview}</span>.
              Matching users receive {state.groupIds.length ? `${state.groupIds.length} default group${state.groupIds.length === 1 ? "" : "s"}` : "no default groups"}.
            </p>
          ) : (
            <p className="mt-1 text-ink-muted">Enter a value to preview the exact normalized match before saving.</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <button className={primaryButton} disabled={status.actionsDisabled} type="submit">
            <Check aria-hidden="true" className="size-3.5" /> Save rule
          </button>
          <button className={quietButton} onClick={actions.backToList} type="button">Cancel</button>
        </div>
      </form>
    </div>
  );
}

function RuleDetail({ actions, rule, status }: Readonly<{
  actions: AdminAccessRulesSectionActions;
  rule: AdminAccessRuleRecord | null;
  status: AdminAccessRulesSectionStatus;
}>) {
  if (!rule) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <AdminTaskBackButton label="Back to access rules" onClick={actions.backToList} />
        <EmptyState detail="Select a rule to review its exact scope and default groups." title="No access rule selected" />
      </div>
    );
  }

  return (
    <article className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7" data-testid="admin-access-rule-detail">
      <AdminTaskBackButton label="Back to access rules" onClick={actions.backToList} />
      <div className="border-b border-trace-subtle pb-5">
        <p className="text-metadata font-semibold uppercase tracking-[0.1em] text-ink-muted">Exact {rule.kind} rule</p>
        <div className="mt-2 flex min-w-0 items-start gap-3">
          {rule.kind === "email" ? <Mail aria-hidden="true" className="mt-1 size-4 shrink-0 text-proof" /> : <Globe2 aria-hidden="true" className="mt-1 size-4 shrink-0 text-proof" />}
          <h3 className="min-w-0 flex-1 break-words text-xl font-semibold tracking-tight text-ink [overflow-wrap:anywhere]">{rule.value}</h3>
          <AdminAvailabilityStatus enabled={rule.enabled} />
        </div>
      </div>
      <section className="border-b border-trace-subtle py-5">
        <h4 className="text-sm font-semibold text-ink">Approval result</h4>
        <p className="mt-2 text-sm leading-6 text-ink-secondary">
          {rule.enabled
            ? <>A verified access request matching this exact {rule.kind} is approved with {groupLabel(rule.defaultGroups)}.</>
            : <>This rule is disabled. Matching future access requests are not approved by it.</>}
        </p>
      </section>
      <section className="py-5">
        <h4 className="text-sm font-semibold text-ink">Rule lifecycle</h4>
        <p className="mt-1 max-w-xl text-xs leading-5 text-ink-muted">Rules cannot be edited. Delete this rule and create another to change its scope.</p>
        <button
          className={`${dangerButton} mt-3`}
          disabled={status.actionsDisabled}
          onClick={() => actions.requestDeleteRule({ id: rule.id, kind: rule.kind, value: rule.value })}
          type="button"
        >
          <Trash2 aria-hidden="true" className="size-3.5" /> Delete rule
        </button>
      </section>
    </article>
  );
}

export function AdminAccessRulesSection(props: AdminAccessRulesSectionProps) {
  const { actions, data, state, status } = props;
  return (
    <AdminTaskWorkspace indexWidth="22rem">
      <AdminTaskIndexPane compactDetailOpen={state.compactDetailOpen} testId="admin-access-rules-index">
        <div className="border-b border-trace-subtle p-3">
          <label className="block text-xs font-medium text-ink-secondary" htmlFor="admin-access-rules-search">Search access rules</label>
          <div className="relative mt-1.5">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-muted" />
            <input
              className={`${inputClass} pl-9`}
              id="admin-access-rules-search"
              onChange={(event) => actions.changeQuery(event.currentTarget.value)}
              placeholder="Email, domain, or default group"
              value={state.query}
            />
          </div>
        </div>
        <div className="min-w-0 divide-y divide-trace-subtle" data-testid="admin-access-rules-list">
          {data.rules.length ? data.rules.map((rule) => (
            <article
              className={`min-w-0 px-4 py-3 ${adminAvailabilityRowClass(rule.enabled)} ${
                data.selectedRule?.id === rule.id ? "ring-1 ring-inset ring-proof/45" : ""
              }`}
              data-resource-availability-row={rule.enabled ? "enabled" : "disabled"}
              data-testid="admin-access-rule-row"
              key={rule.id}
            >
              <div className="flex min-w-0 items-start gap-3">
                {rule.kind === "email" ? <Mail aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-proof" /> : <Globe2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-proof" />}
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{rule.value}</p>
                  <p className="mt-1 break-words text-xs text-ink-muted [overflow-wrap:anywhere]">Exact {rule.kind} · {groupLabel(rule.defaultGroups)}</p>
                </div>
                <AdminAvailabilityStatus enabled={rule.enabled} />
              </div>
              <div className="mt-2 flex justify-end">
                <button className={quietButton} onClick={() => actions.selectRule(rule.id)} type="button">Details</button>
              </div>
            </article>
          )) : (
            <EmptyState
              detail={data.totalRuleCount ? "Change the search to see other access rules." : "Create a rule only when recurring approval policy is needed."}
              title={data.totalRuleCount ? "No access rules match this view" : "No access rules"}
            />
          )}
        </div>
      </AdminTaskIndexPane>

      <AdminTaskDetailPane compactDetailOpen={state.compactDetailOpen} testId="admin-access-rules-detail-pane">
        {state.formOpen ? <CreateRuleTask {...props} /> : <RuleDetail actions={actions} rule={data.selectedRule} status={status} />}
      </AdminTaskDetailPane>
    </AdminTaskWorkspace>
  );
}
