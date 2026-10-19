"use client";

import { AdminGroupOptions, inputClass } from "@/components/admin/adminPrimitives";
import { useAdminSectionTopbar } from "@/components/admin/AdminShell";
import { cardClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import {
  telegramAccessDirty,
  telegramBotStatus,
  telegramTokenError,
  type TelegramAccessDraft
} from "@/components/admin/telegram/telegramAdminView";
import {
  useAdminTelegramController,
  type AdminTelegramController
} from "@/components/admin/telegram/useAdminTelegramController";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminGroup } from "@/lib/contracts/admin";
import type { TelegramAdminState } from "@/lib/contracts/telegram";
import { useEffect, useId, useRef, useState } from "react";

const topbar = { title: "Telegram" };
const fieldLabelClass = "mb-1 block text-xs font-medium text-ink-secondary";
const helpTextClass = "mt-1 block text-xs leading-5 text-ink-muted";
const fieldErrorClass = "mt-1 block text-xs leading-5 text-critical";
const alertClass = "rounded-[10px] border border-critical/25 bg-critical/5 px-3 py-2 text-xs leading-5 text-critical";
const STATUS_CLOCK_MS = 5_000;

const pillTone: Record<"critical" | "neutral" | "ok", string> = {
  critical: "border-critical/25 bg-critical/10 text-critical",
  neutral: "border-trace-subtle bg-control-surface text-ink-secondary",
  ok: "border-positive/25 bg-positive/10 text-positive"
};

export type AdminTelegramSectionProps = Readonly<{
  feedback: Pick<AdminFeedbackController, "reportError" | "reportNotice">;
  /** The installation's groups from the dashboard; archived groups are not offered. */
  groups: readonly AdminGroup[];
}>;

function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), STATUS_CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Status word, bot name, poll health and the one on/off action. */
function BotState({ controller, telegram }: Readonly<{ controller: AdminTelegramController; telegram: TelegramAdminState }>) {
  const now = useClock();
  const status = telegramBotStatus(telegram, now);
  const busy = controller.state.busy;
  return (
    <div className={`${cardClass} flex min-w-0 max-w-[760px] flex-wrap items-center justify-between gap-4 px-5 py-4`} data-testid="telegram-bot-state">
      <div className="min-w-0" role="status">
        <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <span
            className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-2 text-metadata font-semibold ${pillTone[status.tone]}`}
            data-status-tone={status.tone}
            data-testid="telegram-bot-status"
          >
            <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
            {status.label}
          </span>
          {telegram.botUsername ? (
            <span className="min-w-0 break-words text-sm font-medium text-ink [overflow-wrap:anywhere]" data-testid="telegram-bot-username">
              @{telegram.botUsername}
            </span>
          ) : null}
        </p>
        <p
          className={`mt-1.5 text-xs leading-5 ${status.tone === "critical" ? "text-critical" : "text-ink-muted"}`}
          data-testid="telegram-bot-health"
        >
          {status.detail}
        </p>
      </div>
      {telegram.enabled ? (
        <UiV2Button
          busy={busy === "disable"}
          data-testid="telegram-disable"
          disabled={busy !== null}
          onClick={() => void controller.actions.setEnabled(false)}
          type="button"
        >
          Disable
        </UiV2Button>
      ) : (
        <UiV2Button
          aria-describedby={telegram.tokenConfigured ? undefined : "telegram-enable-help"}
          busy={busy === "enable"}
          data-testid="telegram-enable"
          disabled={busy !== null || !telegram.tokenConfigured}
          onClick={() => void controller.actions.setEnabled(true)}
          tone="primary"
          type="button"
        >
          Enable
        </UiV2Button>
      )}
      {!telegram.tokenConfigured ? <span className="sr-only" id="telegram-enable-help">Save a bot token first.</span> : null}
    </div>
  );
}

/**
 * The write-only token: the stored token never reaches the browser, the field
 * starts empty and clears once Telegram accepted a new one.
 */
function TokenForm({ controller, telegram }: Readonly<{ controller: AdminTelegramController; telegram: TelegramAdminState }>) {
  const [token, setToken] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [result, setResult] = useState<Readonly<{ ok: boolean; text: string }> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const busy = controller.state.busy;

  const submit = async () => {
    if (busy) return;
    const error = telegramTokenError(token);
    setFieldError(error);
    setResult(null);
    if (error) {
      inputRef.current?.focus();
      return;
    }
    const outcome = await controller.actions.testAndSave(token);
    if (outcome.ok) {
      setToken("");
      setResult({ ok: true, text: "Bot found. The token is saved." });
      return;
    }
    if (outcome.message) setResult({ ok: false, text: outcome.message });
  };

  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const resultId = `${id}-result`;
  return (
    <form
      aria-labelledby={`${id}-heading`}
      className={`${cardClass} max-w-[760px]`}
      data-testid="telegram-token-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-4 px-5 py-5">
        <h2 className={sectionHeadingClass} id={`${id}-heading`}>Bot</h2>
        <div className="min-w-0">
          <label className={fieldLabelClass} htmlFor={id}>Bot token</label>
          <input
            aria-describedby={[helpId, fieldError ? errorId : null].filter(Boolean).join(" ")}
            aria-invalid={fieldError ? true : undefined}
            autoComplete="new-password"
            className={`${inputClass} sm:max-w-[32rem]`}
            disabled={busy !== null}
            id={id}
            onChange={(event) => {
              setToken(event.currentTarget.value);
              setFieldError(null);
              setResult(null);
            }}
            placeholder={telegram.tokenConfigured ? "••••••••" : undefined}
            ref={inputRef}
            spellCheck={false}
            type="password"
            value={token}
          />
          <span className={helpTextClass} id={helpId}>
            Create a bot in @BotFather, paste its token here. Turn off group joining with /setjoingroups → Disable.{" "}
            {telegram.tokenConfigured
              ? "A token is stored and never shown here; paste a new one to replace it."
              : "Stored encrypted and never shown again."}
          </span>
          {fieldError ? <span className={fieldErrorClass} id={errorId}>{fieldError}</span> : null}
        </div>
        {result ? (
          result.ok ? (
            <p className="text-xs leading-5 text-positive" data-testid="telegram-test-result" id={resultId} role="status">
              {result.text}{telegram.botUsername ? <> Connected to <strong>@{telegram.botUsername}</strong>.</> : null}
            </p>
          ) : (
            <p className={alertClass} data-testid="telegram-test-result" id={resultId} role="alert">{result.text}</p>
          )
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-trace-subtle px-5 py-4">
        <UiV2Button busy={busy === "test"} data-testid="telegram-test-and-save" disabled={busy !== null} tone="primary" type="submit">
          Test &amp; Save
        </UiV2Button>
        <span className="min-w-0 text-xs leading-5 text-ink-muted">
          AIQSA asks Telegram for the bot first. If Telegram does not accept the token, the current token stays.
        </span>
      </div>
    </form>
  );
}

/** Everyone or selected groups. The draft survives background refreshes and a stale save. */
function AccessForm({
  controller,
  groups,
  telegram
}: Readonly<{ controller: AdminTelegramController; groups: readonly AdminGroup[]; telegram: TelegramAdminState }>) {
  const [draft, setDraft] = useState<TelegramAccessDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const busy = controller.state.busy;
  const activeIds = new Set(groups.filter((group) => !group.archivedAt).map((group) => group.id.toLowerCase()));
  const current: TelegramAccessDraft = draft ?? { groupIds: telegram.groupIds, restricted: telegram.restricted };
  const keptGroupIds = current.groupIds.filter((groupId) => activeIds.has(groupId.toLowerCase()));
  const unavailable = telegram.restricted ? telegram.groupIds.filter((groupId) => !activeIds.has(groupId.toLowerCase())).length : 0;
  const dirty = telegramAccessDirty(current, telegram);
  const noGroup = current.restricted && keptGroupIds.length === 0;

  const change = (next: TelegramAccessDraft) => {
    setDraft(next);
    setError(null);
  };

  const save = async () => {
    if (busy || !dirty) return;
    if (noGroup) {
      setError("Choose at least one group, or choose Everyone.");
      return;
    }
    const outcome = await controller.actions.setAccess({ groupIds: keptGroupIds, restricted: current.restricted });
    if (outcome.ok) {
      setDraft(null);
      setError(null);
    } else if (outcome.message) {
      setError(outcome.message);
    }
  };

  return (
    <form
      aria-labelledby={`${id}-heading`}
      className={`${cardClass} max-w-[760px]`}
      data-testid="telegram-access-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="grid min-w-0 gap-4 px-5 py-5">
        <h2 className={sectionHeadingClass} id={`${id}-heading`}>Who can use Telegram</h2>
        <fieldset aria-labelledby={`${id}-heading`} className="grid min-w-0 gap-3" disabled={busy !== null}>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              checked={!current.restricted}
              className="mt-0.5 size-4 shrink-0 accent-proof"
              name={`${id}-audience`}
              onChange={() => change({ groupIds: current.groupIds, restricted: false })}
              type="radio"
            />
            <span>Everyone<span className="mt-0.5 block text-xs leading-5 text-ink-muted">Every active user can connect Telegram.</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              checked={current.restricted}
              className="mt-0.5 size-4 shrink-0 accent-proof"
              name={`${id}-audience`}
              onChange={() => change({ groupIds: current.groupIds, restricted: true })}
              type="radio"
            />
            <span>
              Selected groups
              <span className="mt-0.5 block text-xs leading-5 text-ink-muted">
                Only members of these groups. Leaving a group turns Telegram off for that user; their link is kept.
              </span>
            </span>
          </label>
          {current.restricted ? (
            <div className="min-w-0 pl-6">
              <AdminGroupOptions
                groups={[...groups]}
                label="Groups"
                onChange={(groupIds) => change({ groupIds, restricted: true })}
                selected={[...current.groupIds]}
              />
              {unavailable > 0 && draft === null ? (
                <p className="mt-2 text-xs leading-5 text-caution" data-testid="telegram-access-unavailable-groups">
                  {unavailable === 1 ? "1 selected group is" : `${unavailable} selected groups are`} archived or deleted and
                  give no access. Saving the access removes {unavailable === 1 ? "it" : "them"}.
                </p>
              ) : null}
            </div>
          ) : null}
        </fieldset>
        {error ? <p className={alertClass} role="alert">{error}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-trace-subtle px-5 py-4">
        <UiV2Button busy={busy === "access"} data-testid="telegram-save-access" disabled={busy !== null || !dirty} tone="primary" type="submit">
          Save access
        </UiV2Button>
        {dirty ? (
          <UiV2Button disabled={busy !== null} onClick={() => { setDraft(null); setError(null); }} type="button">
            Discard
          </UiV2Button>
        ) : null}
        <span className="min-w-0 text-xs leading-5 text-ink-muted" role="status">
          {dirty ? "Unsaved access changes." : "Access is checked on every message and before every delivery."}
        </span>
      </div>
    </form>
  );
}

/**
 * Admin → Telegram (PRD D-03, D-23): the bot state with its health and
 * Enable/Disable, the write-only token with Test & Save, and who may use the
 * bot. Commands carry the version this page read; a stale one reloads the
 * state and keeps the input.
 */
export function AdminTelegramSection({ feedback, groups }: AdminTelegramSectionProps) {
  useAdminSectionTopbar(topbar);
  const controller = useAdminTelegramController({ onError: feedback.reportError, onNotice: feedback.reportNotice });
  const { error, loaded, loading, telegram } = controller.state;

  if (!telegram) {
    return (
      <div className="px-4 py-12 text-center sm:px-6" data-testid="admin-telegram-section" role={loaded && error ? "alert" : "status"}>
        {loaded && error ? (
          <>
            <p className="text-sm font-semibold text-ink-secondary">{error}</p>
            <UiV2Button className="mt-4" disabled={loading} onClick={() => void controller.actions.refresh()} type="button">
              Try again
            </UiV2Button>
          </>
        ) : (
          <p className="text-sm text-ink-muted">Loading Telegram settings…</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex max-w-[1120px] min-w-0 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8" data-testid="admin-telegram-section">
      <p className="max-w-2xl text-sm leading-6 text-ink-secondary">
        Let people chat with AIQSA from Telegram through one bot. Each person connects their own account in Settings → Connections.
      </p>
      {error ? <p className="text-xs leading-5 text-critical" role="alert">{error}</p> : null}
      <BotState controller={controller} telegram={telegram} />
      <TokenForm controller={controller} telegram={telegram} />
      <AccessForm controller={controller} groups={groups} telegram={telegram} />
    </div>
  );
}
