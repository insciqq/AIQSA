"use client";

import { focusRing } from "@/components/admin/adminPrimitives";
import { useAdminSectionTopbar } from "@/components/admin/AdminShell";
import {
  DiscordAgentForm,
  DiscordChannelsForm,
  DiscordDirectMessages,
  DiscordLimitsForm,
  DiscordServerForm,
  DiscordTestModeForm,
  DiscordTokenForm
} from "@/components/admin/discord/AdminDiscordBotForms";
import { DiscordActivity, DiscordMonitoringKeys } from "@/components/admin/discord/AdminDiscordMonitoring";
import {
  alertClass,
  discordCardClass,
  type DiscordFocusTarget,
  DiscordSectionLink,
  DiscordStatePill,
  sectionHeadingClass,
  useDiscordClock,
  type DiscordNavigate
} from "@/components/admin/discord/discordAdminParts";
import { discordBotStatus, discordSetupItemView, orderedSetupItems } from "@/components/admin/discord/discordAdminView";
import {
  useAdminDiscordController,
  type AdminDiscordController
} from "@/components/admin/discord/useAdminDiscordController";
import type { AdminConfirmationRequest } from "@/components/admin/useAdminConfirmationController";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import { UiV2Button } from "@/components/ui-v2";
import type { DiscordAdminState, DiscordSetupItem } from "@/lib/contracts/discord";
import { useId, useState } from "react";

const topbar = { title: "Discord" };
const STATUS_CLOCK_MS = 5_000;

export type AdminDiscordSectionProps = Readonly<{
  feedback: Pick<AdminFeedbackController, "reportError" | "reportNotice">;
  onNavigateSection: DiscordNavigate;
  requestConfirmation(config: AdminConfirmationRequest): void;
}>;


/** Moves to the field or heading marked `data-discord-focus`; a setup action or status action points there. */
function focusTarget(target: DiscordFocusTarget) {
  const element = document.querySelector<HTMLElement>(`[data-discord-focus="${target}"]`);
  if (!element) return;
  // Centered, so the field is not hidden under the sticky top bar; an instant jump also respects reduced motion.
  if (typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "center" });
  element.focus({ preventScroll: true });
}

/** Connected or Disconnected with its reason and what to do, and the one big on/off action. */
function BotState({
  controller,
  discord
}: Readonly<{ controller: AdminDiscordController; discord: DiscordAdminState }>) {
  const now = useDiscordClock(STATUS_CLOCK_MS);
  const [refusal, setRefusal] = useState<Readonly<{ code: string; message: string }> | null>(null);
  const status = discordBotStatus(discord, now);
  const busy = controller.state.busy;
  const enableBlocked = !discord.tokenConfigured || !discord.setup.ready;

  const toggle = async (enabled: boolean) => {
    setRefusal(null);
    const outcome = await controller.actions.setEnabled(enabled);
    if (!outcome.ok && outcome.message && !outcome.stale) setRefusal({ code: outcome.code, message: outcome.message });
  };

  return (
    <section
      aria-label="Discord bot status"
      className={`${discordCardClass} grid gap-3 px-5 py-4`}
      data-testid="discord-bot-state"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-4">
        <div className="min-w-[min(100%,20rem)] flex-1" role="status">
          <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
            <DiscordStatePill testId="discord-bot-status" tone={status.tone}>{status.label}</DiscordStatePill>
            {discord.bot ? (
              <span className="min-w-0 break-words text-sm font-medium text-ink [overflow-wrap:anywhere]" data-testid="discord-bot-username">
                @{discord.bot.username}
              </span>
            ) : null}
            {discord.guild ? (
              <span className="min-w-0 break-words text-xs text-ink-muted [overflow-wrap:anywhere]">in {discord.guild.name}</span>
            ) : null}
          </p>
          <p
            className={`mt-1.5 text-xs leading-5 ${status.tone === "critical" ? "text-critical" : "text-ink-muted"}`}
            data-testid="discord-bot-health"
          >
            {status.detail}
          </p>
        </div>
        {discord.enabled ? (
          <UiV2Button
            busy={busy === "disable"}
            className="min-w-[7.5rem]"
            data-testid="discord-disable"
            disabled={busy !== null}
            onClick={() => void toggle(false)}
            tone="destructive"
            type="button"
          >
            Disable
          </UiV2Button>
        ) : (
          <UiV2Button
            aria-describedby={enableBlocked ? "discord-enable-help" : undefined}
            busy={busy === "enable"}
            className="min-w-[7.5rem]"
            data-testid="discord-enable"
            disabled={busy !== null || enableBlocked}
            onClick={() => void toggle(true)}
            tone="primary"
            type="button"
          >
            Enable
          </UiV2Button>
        )}
      </div>
      {enableBlocked && !discord.enabled ? (
        <span className="sr-only" id="discord-enable-help">
          {discord.tokenConfigured ? "Finish the setup checklist first." : "Save a bot token first."}
        </span>
      ) : null}
      {status.action ? (
        <div>
          <UiV2Button
            data-testid="discord-status-action"
            onClick={() => focusTarget(status.action === "enter_token" ? "token" : "setup")}
            type="button"
          >
            {status.action === "enter_token" ? (discord.tokenConfigured ? "Enter a new token" : "Enter token") : "Review setup"}
          </UiV2Button>
        </div>
      ) : null}
      {discord.enabled ? (
        <p className="text-xs leading-5 text-ink-muted">
          Disable stops the bot within seconds: nothing more is sent to Discord. Answers already running finish in AIQSA.
        </p>
      ) : null}
      {refusal ? (
        <div className={`${alertClass} flex flex-wrap items-center gap-2`} data-testid="discord-enable-refusal" role="alert">
          <span className="min-w-0 flex-1">{refusal.message}</span>
          {refusal.code === "discord_setup_incomplete" ? (
            <UiV2Button onClick={() => focusTarget("setup")} type="button">Review setup</UiV2Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function SetupMark({ status }: Readonly<{ status: DiscordSetupItem["status"] }>) {
  if (status === "ok") return <DiscordStatePill tone="ok">Done</DiscordStatePill>;
  if (status === "warning") return <DiscordStatePill tone="warning">Warning</DiscordStatePill>;
  return <DiscordStatePill tone="critical">Needed</DiscordStatePill>;
}

/** The setup check (D-10): every item with its state, its reason and the button or link that fixes it. */
function SetupChecklist({
  controller,
  discord,
  onNavigate
}: Readonly<{ controller: AdminDiscordController; discord: DiscordAdminState; onNavigate: DiscordNavigate }>) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const busy = controller.state.busy;
  const items = orderedSetupItems(discord.setup.items);
  const blocking = items.filter((item) => item.status === "blocking").length;
  const warnings = items.filter((item) => item.status === "warning").length;
  // Problems stay in view; passed checks fold away so a ready bot's page stays short.
  const problems = items.filter((item) => item.status !== "ok");
  const passed = items.filter((item) => item.status === "ok");

  const action = (item: DiscordSetupItem, label: string) => {
    switch (item.action) {
      case "enter_token":
        return <UiV2Button onClick={() => focusTarget("token")} type="button">{label}</UiV2Button>;
      case "select_guild":
        return <UiV2Button onClick={() => focusTarget("guild")} type="button">{label}</UiV2Button>;
      case "select_assistant":
        return <UiV2Button onClick={() => focusTarget("assistant")} type="button">{label}</UiV2Button>;
      case "create_service_account":
        return (
          <UiV2Button
            busy={busy === "service_account"}
            disabled={busy !== null}
            onClick={() => {
              setError(null);
              void controller.actions.createServiceAccount().then((outcome) => {
                if (!outcome.ok && outcome.message) setError(outcome.message);
              });
            }}
            type="button"
          >
            {label}
          </UiV2Button>
        );
      case "open_service_account":
        return discord.serviceAccount.userId
          ? <DiscordSectionLink onNavigate={onNavigate} resource={discord.serviceAccount.userId} section="users">{label}</DiscordSectionLink>
          : null;
      case "open_assistant":
        return discord.assistant
          ? <DiscordSectionLink onNavigate={onNavigate} resource={discord.assistant.id} section="assistants">{label}</DiscordSectionLink>
          : null;
      case "open_mcp_grants":
        return <DiscordSectionLink onNavigate={onNavigate} section="mcp">{label}</DiscordSectionLink>;
      case "open_provider_keys":
        return <DiscordSectionLink onNavigate={onNavigate} section="providers">{label}</DiscordSectionLink>;
      case "open_usage_limits":
        return <DiscordSectionLink onNavigate={onNavigate} section="limits">{label}</DiscordSectionLink>;
      default:
        return null;
    }
  };

  const row = (item: DiscordSetupItem) => {
    const view = discordSetupItemView(item);
    return (
      <li className="grid min-w-0 gap-x-3 gap-y-1.5 py-2.5 sm:grid-cols-[5.5rem_minmax(0,1fr)_auto] sm:items-start" data-code={item.code} key={item.code}>
        <span className="sm:pt-px"><SetupMark status={item.status} /></span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{view.title}</p>
          <p className={`text-xs leading-5 ${item.status === "ok" ? "text-ink-muted" : "text-ink-secondary"}`}>{view.reason}</p>
        </div>
        {view.actionLabel ? <div className="min-w-0 sm:justify-self-end">{action(item, view.actionLabel)}</div> : null}
      </li>
    );
  };

  return (
    <section aria-labelledby={`${id}-heading`} className={discordCardClass} data-testid="discord-setup">
      <div className="grid min-w-0 gap-3 px-5 py-5">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2
            className={`${sectionHeadingClass} rounded-[4px] outline-none focus:ring-2 focus:ring-focus focus:ring-offset-2 focus:ring-offset-answer-paper`}
            id={`${id}-heading`}
            data-discord-focus="setup"
            tabIndex={-1}
          >
            Setup
          </h2>
          <p className="text-xs leading-5 text-ink-muted" data-testid="discord-setup-summary">
            {blocking > 0
              ? `${blocking} ${blocking === 1 ? "item blocks" : "items block"} Enable`
              : warnings > 0
                ? `Ready · ${warnings} ${warnings === 1 ? "warning" : "warnings"}`
                : "Ready"}
          </p>
        </div>
        {problems.length > 0 ? (
          <ul className="grid min-w-0 divide-y divide-trace-subtle" data-testid="discord-setup-items">
            {problems.map(row)}
          </ul>
        ) : null}
        {passed.length > 0 ? (
          <details className="group min-w-0" data-testid="discord-setup-passed">
            <summary className={`w-fit cursor-pointer rounded-[4px] text-xs font-medium text-ink-secondary hover:text-ink ${focusRing}`}>
              {passed.length === 1 ? "1 check passed" : `${passed.length} checks passed`}
            </summary>
            <ul className="mt-1 grid min-w-0 divide-y divide-trace-subtle">{passed.map(row)}</ul>
          </details>
        ) : null}
        {error ? <p className={alertClass} role="alert">{error}</p> : null}
      </div>
    </section>
  );
}

/**
 * Admin → Discord (PRD D-32): status with the kill switch, the setup check,
 * the write-only token, where the bot answers, who answers, limits, test mode,
 * monitoring keys and activity. Commands carry the version this page read; a
 * stale one raises a reload prompt and keeps the unsaved input.
 */
export function AdminDiscordSection({ feedback, onNavigateSection, requestConfirmation }: AdminDiscordSectionProps) {
  useAdminSectionTopbar(topbar);
  const controller = useAdminDiscordController({ onError: feedback.reportError, onNotice: feedback.reportNotice });
  const { discord, error, loaded, loading, stale } = controller.state;

  if (!discord) {
    return (
      <div className="px-4 py-12 text-center sm:px-6" data-testid="admin-discord-section" role={loaded && error ? "alert" : "status"}>
        {loaded && error ? (
          <>
            <p className="text-sm font-semibold text-ink-secondary">{error}</p>
            <UiV2Button className="mt-4" disabled={loading} onClick={() => void controller.actions.reload()} type="button">
              Try again
            </UiV2Button>
          </>
        ) : (
          <p className="text-sm text-ink-muted">Loading Discord settings…</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex max-w-[1120px] min-w-0 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8" data-testid="admin-discord-section">
      <p className="max-w-2xl text-sm leading-6 text-ink-secondary">
        Let people ask AIQSA in Discord: they mention the bot, reply to it or message it, and get an answer in a thread. Every
        answer runs as the Discord service account with the Assistant chosen here.
      </p>
      {stale ? (
        <div className={`${discordCardClass} flex flex-wrap items-center gap-3 border-caution/40 px-5 py-3`} data-testid="discord-stale" role="alert">
          <p className="min-w-0 flex-1 text-xs leading-5 text-ink">
            Another administrator changed the Discord settings. Reload to see them; your unsaved input here is kept.
          </p>
          <UiV2Button disabled={controller.state.busy !== null} onClick={() => void controller.actions.reload()} tone="primary" type="button">
            Reload
          </UiV2Button>
        </div>
      ) : null}
      {error ? <p className="text-xs leading-5 text-critical" role="alert">{error}</p> : null}
      <BotState controller={controller} discord={discord} />
      <SetupChecklist controller={controller} discord={discord} onNavigate={onNavigateSection} />
      <DiscordTokenForm controller={controller} discord={discord} />
      <DiscordServerForm controller={controller} discord={discord} />
      <DiscordChannelsForm controller={controller} discord={discord} />
      <DiscordDirectMessages controller={controller} discord={discord} />
      <DiscordAgentForm controller={controller} discord={discord} onNavigate={onNavigateSection} />
      <DiscordLimitsForm controller={controller} discord={discord} />
      <DiscordTestModeForm controller={controller} discord={discord} />
      <DiscordMonitoringKeys requestConfirmation={requestConfirmation} />
      <DiscordActivity />
    </div>
  );
}
