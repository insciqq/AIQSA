"use client";

import { AdminSearchablePicker, type AdminSearchablePickerItem } from "@/components/admin/AdminSearchablePicker";
import { providerDisplayName, providerModelDisplayName, searchStrategyDisplayName } from "@/components/admin/adminViewUtils";
import { modelCapabilityLabels } from "@/components/admin/providers/models/modelChips";
import {
  catalogModelsForProvider,
  groupDeletionInfo,
  groupHeaderSummary,
  groupMemberCandidates,
  groupMembers,
  groupProviderKey,
  isFullAccessGroup,
  providerAccess,
  providerAccessLabel,
  providerModelChanges,
  type AdminGroupProviderAccess
} from "@/components/admin/groups/groupsView";
import { AdminMcpGroupAccessPanel } from "@/components/admin/mcp/AdminMcpGrantPanels";
import { cardClass } from "@/components/admin/mcp/mcpPrimitives";
import type { AdminGroupsController } from "@/components/admin/useAdminGroupsController";
import type { AdminMcpController } from "@/components/admin/useAdminMcpController";
import { formatShortDay, userInitials } from "@/components/admin/users/usersView";
import { UserAvatar, UsersTag, sectionHeadingClass } from "@/components/admin/users/usersPrimitives";
import { UiV2Button, UiV2Icon, UiV2ProviderMark, UiV2Switch } from "@/components/ui-v2";
import type { AdminCatalog, AdminGroup, AdminUserRecord } from "@/lib/contracts/admin";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import { useEffect, useRef, type ReactNode } from "react";

export type AdminGroupPageProviders = Readonly<{
  connections: readonly AdminProviderConnection[];
  error: string | null;
  loaded: boolean;
}>;

export type AdminGroupPageProps = Readonly<{
  catalog: AdminCatalog;
  controller: AdminGroupsController;
  group: AdminGroup;
  mcp: AdminMcpController;
  nowMs: number;
  onRename(): void;
  providers: AdminGroupPageProviders;
  users: readonly AdminUserRecord[];
}>;

const helpClass = "text-xs leading-5 text-ink-muted";
const rowClass = "flex min-h-14 min-w-0 items-center gap-3 px-4 py-2.5 sm:px-5";

function Section({ actions, children, heading, note, testId }: Readonly<{
  actions?: ReactNode;
  children: ReactNode;
  heading: string;
  note?: ReactNode;
  testId: string;
}>) {
  return (
    <section aria-label={heading} className="flex min-w-0 flex-col gap-3" data-testid={testId}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3 className={sectionHeadingClass}>{heading}</h3>
        {actions ?? (note ? <span className={helpClass}>{note}</span> : null)}
      </div>
      {children}
    </section>
  );
}

function CapabilityChip({ children }: Readonly<{ children: string }>) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-[6px] border border-proof/25 bg-proof/[0.08] px-1.5 text-metadata font-medium text-proof">
      <UiV2Icon className="size-3" name="check" />
      {children}
    </span>
  );
}

function MembersSection({ controller, disabled, editable, group, users }: Readonly<{
  controller: AdminGroupsController;
  disabled: boolean;
  editable: boolean;
  group: AdminGroup;
  users: readonly AdminUserRecord[];
}>) {
  const members = groupMembers(users, group.id);
  const candidates: AdminSearchablePickerItem[] = groupMemberCandidates(users, group.id).map((user) => ({
    id: user.id,
    keywords: [user.role],
    label: user.displayName,
    secondaryText: user.email ?? "no email"
  }));
  return (
    <Section heading={`Members · ${members.length}`} testId="admin-group-members">
      {editable ? (
        // Left-aligned so the picker's results panel opens inside the page on every width.
        <div className="w-full sm:w-80">
          <AdminSearchablePicker
            disabled={disabled}
            emptyDescription="Every active user is already a member."
            emptyTitle="No one to add"
            items={candidates}
            label="Add a person"
            noun={{ plural: "people", singular: "person" }}
            onSelect={(item) => void controller.actions.setMembership(group, item.id, true)}
            placeholder="Add a person…"
            searchPlaceholder="Name or email"
          />
        </div>
      ) : null}
      <div className={cardClass}>
        {members.length ? (
          <ul aria-label="Members" className="divide-y divide-trace-subtle">
            {members.map((user) => (
              <li className={rowClass} data-testid="admin-group-member" key={user.id}>
                <UserAvatar initials={userInitials(user)} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{user.displayName}</p>
                  <p className="truncate text-xs text-ink-muted">
                    {[user.email ?? "no email", user.role === "admin" ? "admin" : null, user.status !== "active" ? user.status : null]
                      .filter((part): part is string => part !== null)
                      .join(" · ")}
                  </p>
                </div>
                {editable ? (
                  <UiV2Button
                    disabled={disabled}
                    onClick={() => void controller.actions.setMembership(group, user.id, false)}
                    tone="ghost"
                    type="button"
                  >
                    Remove
                  </UiV2Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-6 text-sm text-ink-muted" role="status">
            {editable ? "No members yet. Add a person to give them this group's access." : "No members."}
          </p>
        )}
      </div>
    </Section>
  );
}

function ProviderModels({ access, catalog, connection, controller, disabled, group, provider }: Readonly<{
  access: AdminGroupProviderAccess;
  catalog: AdminCatalog;
  connection: AdminProviderConnection | null;
  controller: AdminGroupsController;
  disabled: boolean;
  group: AdminGroup;
  provider: AdminCatalog["providers"][number];
}>) {
  const models = catalogModelsForProvider(catalog, provider.id);
  const granted = new Set(access.kind === "some" ? access.modelIds : []);
  const overrideCredentialId = connection?.assignments.find((assignment) => assignment.group.id === group.id)?.credentialId ?? null;
  const allGranted = models.length > 0 && models.every((model) => granted.has(model.modelId));
  if (!models.length) {
    return <p className="py-2 pl-12 pr-4 text-xs text-ink-muted sm:pl-[4.25rem]">No models on this provider yet.</p>;
  }
  return (
    <>
      <ul aria-label={`${provider.name} models`} className="divide-y divide-trace-subtle">
        {models.map((model) => {
          const chips = modelCapabilityLabels({ connection, credentialId: overrideCredentialId, modelId: model.modelId });
          const checked = granted.has(model.modelId);
          return (
            <li
              className="grid min-h-11 min-w-0 grid-cols-[minmax(0,1fr)] items-center gap-x-4 gap-y-1 py-2 pl-12 pr-4 sm:pl-[4.25rem] sm:pr-5 md:grid-cols-[minmax(0,1fr)_auto]"
              data-testid="admin-group-model"
              key={model.modelId}
            >
              <label className="flex min-w-0 items-center gap-3 text-[13px] text-ink">
                <input
                  checked={checked}
                  className="size-4 shrink-0 accent-proof"
                  disabled={disabled}
                  onChange={(event) => void controller.actions.applyGrants(
                    group,
                    [{ enabled: event.currentTarget.checked, modelId: model.modelId, provider: provider.id }],
                    event.currentTarget.checked ? `${model.displayName} granted.` : `${model.displayName} revoked.`
                  )}
                  type="checkbox"
                />
                <span className="min-w-0 truncate">{model.displayName}</span>
              </label>
              <div className="flex min-w-0 flex-wrap items-center gap-1 md:justify-end">
                {model.modelClass === "embedding" ? <UsersTag>Embedding</UsersTag> : null}
                {chips.map((chip) => <CapabilityChip key={chip}>{chip}</CapabilityChip>)}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2 py-2 pl-12 pr-4 sm:pl-[4.25rem] sm:pr-5">
        {allGranted ? null : (
          <UiV2Button
            aria-label={`Grant all ${provider.name} models to ${group.name}`}
            disabled={disabled}
            onClick={() => void controller.actions.applyGrants(
              group,
              providerModelChanges(catalog, provider.id, true),
              `All current ${provider.name} models granted.`
            )}
            tone="ghost"
            type="button"
          >
            Grant all models
          </UiV2Button>
        )}
        {granted.size ? (
          <UiV2Button
            aria-label={`Revoke all ${provider.name} models from ${group.name}`}
            disabled={disabled}
            onClick={() => void controller.actions.applyGrants(
              group,
              providerModelChanges(catalog, provider.id, false),
              `${provider.name} models revoked.`
            )}
            tone="ghost"
            type="button"
          >
            Clear
          </UiV2Button>
        ) : null}
      </div>
    </>
  );
}

function ModelsSection({ catalog, controller, disabled, group, providers }: Readonly<{
  catalog: AdminCatalog;
  controller: AdminGroupsController;
  disabled: boolean;
  group: AdminGroup;
  providers: AdminGroupPageProviders;
}>) {
  const sortedProviders = [...catalog.providers].sort((left, right) => left.name.localeCompare(right.name));
  return (
    <Section
      heading="Models"
      note={providers.error ? "Provider keys could not be loaded" : "Changes apply to new chats right away"}
      testId="admin-group-models"
    >
      <div className={cardClass}>
        {sortedProviders.length ? (
          <ul aria-label="Providers" className="divide-y divide-trace-subtle">
            {sortedProviders.map((provider) => {
              const access = providerAccess(group, provider.id);
              const connection = providers.connections.find((candidate) => candidate.id === provider.id) ?? null;
              const key = access.kind === "none" ? null : groupProviderKey(connection, group.id);
              const family = connection?.family ?? catalogModelsForProvider(catalog, provider.id)[0]?.providerFamily ?? null;
              return (
                <li className="min-w-0" data-provider-access={access.kind} data-testid={`admin-group-provider-${provider.id}`} key={provider.id}>
                  <div className={`${rowClass} bg-workspace-rail/45`}>
                    <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-[8px] border border-trace-strong bg-answer-paper">
                      <UiV2ProviderMark family={family} label={provider.name} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">{provider.name}</p>
                      <p className="truncate text-xs text-ink-muted">
                        {providerAccessLabel(access, catalogModelsForProvider(catalog, provider.id).length)}
                      </p>
                    </div>
                    {key ? (
                      <span
                        className={`hidden shrink-0 text-xs sm:block ${key.override ? "text-proof" : "text-ink-muted"}`}
                        data-testid="admin-group-provider-key"
                      >
                        {key.label}
                      </span>
                    ) : null}
                    <UiV2Switch
                      checked={access.kind === "all"}
                      disabled={disabled}
                      label={`All ${provider.name} models, including ones added later`}
                      onChange={(next) => void controller.actions.applyGrants(
                        group,
                        [{ enabled: next, provider: provider.id }],
                        next ? `${provider.name}: all models granted.` : `${provider.name}: choose models below.`
                      )}
                    />
                  </div>
                  {key ? (
                    <p className={`px-4 pb-2 text-xs sm:hidden ${key.override ? "text-proof" : "text-ink-muted"}`}>{key.label}</p>
                  ) : null}
                  {access.kind === "all" ? null : (
                    <ProviderModels
                      access={access}
                      catalog={catalog}
                      connection={connection}
                      controller={controller}
                      disabled={disabled}
                      group={group}
                      provider={provider}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-5 py-6 text-sm text-ink-muted" role="status">
            No providers with active models yet. Set one up in Providers.
          </p>
        )}
      </div>
    </Section>
  );
}

function SearchSection({ catalog, controller, disabled, group }: Readonly<{
  catalog: AdminCatalog;
  controller: AdminGroupsController;
  disabled: boolean;
  group: AdminGroup;
}>) {
  const granted = new Set(
    group.accessGrants.filter((grant) => grant.enabled && grant.searchStrategy).map((grant) => grant.searchStrategy)
  );
  return (
    <Section heading="Search sources" testId="admin-group-search">
      <div className={cardClass}>
        {catalog.searchStrategies.length ? (
          <ul aria-label="Search sources" className="divide-y divide-trace-subtle">
            {catalog.searchStrategies.map((source) => (
              <li className={rowClass} key={source.strategyId}>
                <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{source.displayName}</p>
                <UiV2Switch
                  checked={granted.has(source.strategyId)}
                  disabled={disabled}
                  label={`${source.displayName} for ${group.name}`}
                  onChange={(next) => void controller.actions.applyGrants(
                    group,
                    [{ enabled: next, searchStrategy: source.strategyId }],
                    next ? `${source.displayName} granted.` : `${source.displayName} revoked.`
                  )}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-6 text-sm text-ink-muted" role="status">No Search sources yet. Set one up in Search.</p>
        )}
      </div>
    </Section>
  );
}

function UnavailableGrants({ catalog, controller, disabled, group }: Readonly<{
  catalog: AdminCatalog;
  controller: AdminGroupsController;
  disabled: boolean;
  group: AdminGroup;
}>) {
  const grants = group.accessGrants.filter((grant) => !grant.enabled || (grant.searchStrategy
    ? !catalog.searchStrategies.some((source) => source.strategyId === grant.searchStrategy)
    : grant.modelId
      ? !catalog.models.some((model) => model.modelId === grant.modelId && model.provider === grant.provider)
      : !catalog.providers.some((provider) => provider.id === grant.provider)));
  if (!grants.length) return null;
  return (
    <Section heading="Unavailable access" testId="admin-group-unavailable-grants">
      <p className={helpClass}>Saved grants remain visible when resources are disabled or archived.</p>
      <ul aria-label="Unavailable grants" className={`${cardClass} divide-y divide-trace-subtle`}>
        {grants.map((grant) => {
          const label = grant.resourceDisplayName ?? (grant.searchStrategy
            ? searchStrategyDisplayName(catalog, grant.searchStrategy)
            : grant.modelId && grant.provider
              ? providerModelDisplayName(catalog, { modelId: grant.modelId, provider: grant.provider })
              : providerDisplayName(catalog, grant.provider ?? ""));
          return (
            <li className={rowClass} key={grant.id}>
              <p className="min-w-0 flex-1 break-words text-sm text-ink [overflow-wrap:anywhere]">{label}{grant.enabled ? "" : " · Disabled grant"}</p>
              <UiV2Button disabled={disabled} onClick={() => void controller.actions.applyGrants(group, [{
                enabled: false, modelId: grant.modelId, provider: grant.provider, searchStrategy: grant.searchStrategy
              }], "Saved grant removed.")} tone="ghost" type="button">Remove grant</UiV2Button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/**
 * One group's page (PRD 5.9): members with a searchable add, the models per
 * provider behind a provider-wide switch or a checklist with capability
 * chips beside the read-only key line, and the Search source and MCP server
 * switches. Every toggle applies immediately through one grant batch.
 */
export function AdminGroupPage({
  catalog,
  controller,
  group,
  mcp,
  nowMs,
  onRename,
  providers,
  users
}: AdminGroupPageProps) {
  const articleRef = useRef<HTMLElement>(null);
  const fullAccess = isFullAccessGroup(group);
  const archived = group.archivedAt !== null;
  const editable = !archived;
  const disabled = controller.actionsDisabled || archived;
  const deletion = groupDeletionInfo(group);
  const mcpServerCount = fullAccess || !mcp.state.loaded
    ? null
    : mcp.state.servers.filter((server) =>
        !server.archivedAt && server.grants.some((grant) => grant.groupId === group.id && grant.canUse)
      ).length;

  useEffect(() => {
    articleRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <article
      aria-label={`Group ${group.name}`}
      className="flex max-w-[1120px] flex-col gap-6 px-4 py-6 outline-none sm:px-6 lg:px-8"
      data-testid="admin-group-page"
      ref={articleRef}
      tabIndex={-1}
    >
      <header className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="break-words text-xl font-semibold leading-tight text-ink [overflow-wrap:anywhere]">{group.name}</h2>
            {fullAccess ? <UsersTag>Built-in</UsersTag> : null}
            {archived ? <UsersTag dot>Archived {formatShortDay(group.archivedAt!, new Date(nowMs))}</UsersTag> : null}
          </div>
          <p className="mt-0.5 text-[13px] text-ink-muted">{groupHeaderSummary(group, catalog, mcpServerCount)}</p>
        </div>
        {fullAccess || archived ? null : (
          <UiV2Button disabled={controller.actionsDisabled} icon="edit" onClick={onRename} tone="ghost" type="button">
            Rename
          </UiV2Button>
        )}
      </header>

      {archived ? (
        <p className="border-l-2 border-caution bg-caution/5 px-3 py-2 text-xs leading-5 text-caution" role="status">
          This group is archived. Its grants no longer apply, and access can no longer be changed.
        </p>
      ) : null}

      <MembersSection controller={controller} disabled={controller.actionsDisabled} editable={editable} group={group} users={users} />

      {fullAccess ? (
        <section aria-label="Access" className="flex min-w-0 flex-col gap-3" data-testid="admin-group-full-access">
          <h3 className={sectionHeadingClass}>Access</h3>
          <p className="border-l-2 border-proof/35 bg-proof/5 px-3 py-2 text-xs leading-5 text-ink-secondary">
            Full access is built in. Members can use every current and future provider, model, Search source and MCP server,
            so there is nothing to switch here. Provider keys and personal MCP values stay separate, and the group cannot be
            renamed, archived or deleted.
          </p>
        </section>
      ) : (
        <>
          <ModelsSection catalog={catalog} controller={controller} disabled={disabled} group={group} providers={providers} />
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
            <SearchSection catalog={catalog} controller={controller} disabled={disabled} group={group} />
            <Section heading="MCP servers" testId="admin-group-mcp">
              <AdminMcpGroupAccessPanel controller={mcp} group={group} />
            </Section>
          </div>
          <UnavailableGrants catalog={catalog} controller={controller} disabled={disabled} group={group} />
          {deletion.canDelete ? null : (
            <p className={helpClass} data-testid="admin-group-deletion">Delete is unavailable: {deletion.summary}</p>
          )}
        </>
      )}
    </article>
  );
}
