"use client";

import { focusRing, inputClass } from "@/components/admin/adminPrimitives";
import {
  adminDiscordErrorMessage,
  createDiscordMonitoringKey,
  requestDiscordActivity,
  requestDiscordMonitoringKeys,
  revokeDiscordMonitoringKey
} from "@/components/admin/discord/adminDiscordApi";
import {
  alertClass,
  cardBodyClass,
  cardFooterClass,
  discordCardClass,
  DiscordStatePill,
  fieldLabelClass,
  footerNoteClass,
  sectionHeadingClass,
  useDiscordClock
} from "@/components/admin/discord/discordAdminParts";
import {
  discordOutcomeLabel,
  discordRelativeTime,
  formatDiscordLatency,
  formatDiscordTime
} from "@/components/admin/discord/discordAdminView";
import { useDiscordListing } from "@/components/admin/discord/useDiscordListing";
import type { AdminConfirmationRequest } from "@/components/admin/useAdminConfirmationController";
import { UiV2Button } from "@/components/ui-v2";
import { UiV2Sheet } from "@/components/ui-v2/SheetV2";
import {
  DISCORD_MONITORING_KEYS_MAX,
  type DiscordActivityRow,
  type DiscordActivityStats,
  type DiscordMonitoringKey
} from "@/lib/contracts/discord";
import { useId, useRef, useState } from "react";

const loadKeys = () => requestDiscordMonitoringKeys();
const loadActivity = () => requestDiscordActivity();

function keyLabel(key: DiscordMonitoringKey): string {
  return `Key created ${formatDiscordTime(key.createdAt)}`;
}

/** The secret of a key just created: shown once, copied by the administrator, never kept by the page. */
function CreatedKeySheet({ onClose, secret }: Readonly<{ onClose(): void; secret: string }>) {
  const [copy, setCopy] = useState<"copied" | "failed" | null>(null);
  const id = useId();
  return (
    <UiV2Sheet
      description="Copy the key now. It cannot be shown again after this panel closes."
      footer={<UiV2Button data-testid="discord-key-done" onClick={onClose} tone="primary" type="button">Done</UiV2Button>}
      onClose={onClose}
      open
      testId="discord-key-created"
      title="Monitoring key created"
    >
      <div className="flex flex-col gap-4">
        <div>
          <label className={fieldLabelClass} htmlFor={id}>Monitoring key</label>
          <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <input
              className={`${inputClass} font-mono text-xs`}
              data-testid="discord-key-secret"
              id={id}
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              value={secret}
            />
            <UiV2Button
              icon={copy === "copied" ? "check" : "copy"}
              onClick={() => {
                void navigator.clipboard.writeText(secret).then(() => setCopy("copied"), () => setCopy("failed"));
              }}
              type="button"
            >
              {copy === "copied" ? "Copied" : "Copy"}
            </UiV2Button>
          </div>
          {copy === "failed" ? (
            <p className="mt-1.5 text-xs leading-5 text-critical" role="alert">Copy failed. Select the key and copy it by hand.</p>
          ) : null}
        </div>
        <p className="text-xs leading-5 text-ink-muted">
          Send it as <code className="font-mono">Authorization: Bearer &lt;key&gt;</code> to{" "}
          <code className="font-mono">/api/monitoring/discord</code> for the request journal and to{" "}
          <code className="font-mono">/api/monitoring/discord/metrics</code> for Prometheus metrics. Neither returns message text.
        </p>
      </div>
    </UiV2Sheet>
  );
}

export function DiscordMonitoringKeys({
  requestConfirmation
}: Readonly<{ requestConfirmation(config: AdminConfirmationRequest): void }>) {
  const keys = useDiscordListing("keys", loadKeys);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const list = keys.data?.keys ?? [];
  const active = list.filter((key) => !key.revokedAt);
  const nowMs = useDiscordClock(60_000);

  const create = async () => {
    if (busy) return;
    setBusy("create");
    setError(null);
    const result = await createDiscordMonitoringKey();
    setBusy(null);
    if (!result.ok) {
      setError(adminDiscordErrorMessage(result.error));
      return;
    }
    setCreated(result.data.secret);
    keys.reload();
  };

  // Create key was busy, so it lost focus while the key was made; the closed panel hands focus back to it.
  const closeCreated = () => {
    setCreated(null);
    window.setTimeout(() => createRef.current?.focus(), 0);
  };

  const revoke = (key: DiscordMonitoringKey) => {
    requestConfirmation({
      body: "Monitoring that sends this key gets 404 from now on. Other keys keep working.",
      confirmLabel: "Revoke key",
      dialogLabel: "Revoke monitoring key",
      icon: "trash",
      onConfirm: async () => {
        setBusy(key.id);
        setError(null);
        const result = await revokeDiscordMonitoringKey(key.id);
        setBusy(null);
        if (result.ok) keys.replace(result.data);
        else setError(adminDiscordErrorMessage(result.error));
      },
      testId: "discord-confirm-revoke-key",
      title: `Revoke the ${keyLabel(key).toLowerCase()}?`,
      tone: "destructive"
    });
  };

  return (
    <section aria-labelledby={`${id}-heading`} className={discordCardClass} data-testid="discord-monitoring-keys">
      <div className={cardBodyClass}>
        <div>
          <h2 className={sectionHeadingClass} id={`${id}-heading`}>Monitoring keys</h2>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            Outside monitoring reads Discord request counts, failures and metrics with a key. No message text leaves AIQSA this way.
          </p>
        </div>
        {keys.loading && !keys.data ? <p className="text-xs text-ink-muted" role="status">Loading keys…</p> : null}
        {keys.error ? (
          <p className={`${alertClass} flex flex-wrap items-center gap-2`} role="alert">
            <span className="min-w-0 flex-1">{keys.error}</span>
            <UiV2Button onClick={keys.reload} type="button">Try again</UiV2Button>
          </p>
        ) : null}
        {keys.data && list.length === 0 ? <p className="text-xs text-ink-muted">No monitoring keys yet.</p> : null}
        {list.length > 0 ? (
          <ul className="grid min-w-0 divide-y divide-trace-subtle rounded-[10px] border border-trace-subtle" data-testid="discord-key-list">
            {list.map((key) => (
              <li className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2.5" key={key.id}>
                <div className="min-w-0">
                  <p className="text-sm text-ink">{keyLabel(key)}</p>
                  <p className="text-xs leading-5 text-ink-muted">
                    {key.revokedAt
                      ? `Revoked ${discordRelativeTime(key.revokedAt, nowMs)}`
                      : key.lastUsedAt ? `Last used ${discordRelativeTime(key.lastUsedAt, nowMs)}` : "Never used"}
                  </p>
                </div>
                {key.revokedAt ? (
                  <DiscordStatePill tone="neutral">Revoked</DiscordStatePill>
                ) : (
                  <UiV2Button
                    aria-label={`Revoke ${keyLabel(key).toLowerCase()}`}
                    busy={busy === key.id}
                    disabled={busy !== null}
                    onClick={() => revoke(key)}
                    tone="destructive"
                    type="button"
                  >
                    Revoke
                  </UiV2Button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {error ? <p className={alertClass} role="alert">{error}</p> : null}
      </div>
      <div className={cardFooterClass}>
        <UiV2Button
          busy={busy === "create"}
          data-testid="discord-create-key"
          ref={createRef}
          disabled={busy !== null || !keys.data || active.length >= DISCORD_MONITORING_KEYS_MAX}
          onClick={() => void create()}
          type="button"
        >
          Create key
        </UiV2Button>
        <span className={footerNoteClass}>
          {active.length >= DISCORD_MONITORING_KEYS_MAX
            ? `At most ${DISCORD_MONITORING_KEYS_MAX} active keys. Revoke one to create another.`
            : "The key is shown once. AIQSA keeps only its hash."}
        </span>
      </div>
      {created ? <CreatedKeySheet onClose={closeCreated} secret={created} /> : null}
    </section>
  );
}

function StatsColumn({ label, stats }: Readonly<{ label: string; stats: DiscordActivityStats }>) {
  const rows: [string, string][] = [
    ["Questions", String(stats.requests)],
    ["Answered", String(stats.delivered)],
    ["Failed", String(stats.failed)],
    ["Interrupted", String(stats.interrupted)],
    ["Latency p50 / p95", `${formatDiscordLatency(stats.latency.p50Ms)} / ${formatDiscordLatency(stats.latency.p95Ms)}`],
    ["Limit hits", `${stats.limitHits.author} author · ${stats.limitHits.thread} thread · ${stats.limitHits.key} key`],
    ["No sources found", String(stats.notFound)],
    ["Ratings up / down", `${stats.ratingsUp} / ${stats.ratingsDown}`]
  ];
  const failures = [...stats.failuresByCode].sort((left, right) => right.count - left.count).slice(0, 5);
  return (
    <div className="min-w-0">
      <h3 className="text-xs font-semibold text-ink-secondary">{label}</h3>
      <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-xs leading-5">
        {rows.map(([name, value]) => (
          <div className="contents" key={name}>
            <dt className="min-w-0 text-ink-muted">{name}</dt>
            <dd className="text-right tabular-nums text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {failures.length > 0 ? (
        <p className="mt-2 break-words text-xs leading-5 text-ink-muted [overflow-wrap:anywhere]">
          Top failures: {failures.map((failure) => `${failure.code} ×${failure.count}`).join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function ActivityRow({ row }: Readonly<{ row: DiscordActivityRow }>) {
  const outcome = discordOutcomeLabel(row.state, row.kind);
  const failed = row.state === "failed" || row.kind === "refused";
  return (
    <tr className="border-t border-trace-subtle align-top">
      <td className="whitespace-nowrap px-3 py-2 text-ink-muted">{formatDiscordTime(row.receivedAt)}</td>
      <td className="max-w-[10rem] break-words px-3 py-2 text-ink [overflow-wrap:anywhere]">
        {row.authorName}
        {row.test ? <span className="ml-1.5 text-metadata font-semibold uppercase text-ink-muted">Test</span> : null}
      </td>
      <td className="max-w-[10rem] break-words px-3 py-2 text-ink-secondary [overflow-wrap:anywhere]">
        {row.guildId === null ? "Direct message" : row.channelName ? `#${row.channelName}` : "Unknown channel"}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-ink">{formatDiscordLatency(row.latencyMs)}</td>
      <td className="px-3 py-2">
        <span className={failed ? "text-critical" : "text-ink"}>{outcome}</span>
        {row.code ? <span className="block break-words font-mono text-metadata text-ink-muted [overflow-wrap:anywhere]">{row.code}</span> : null}
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        <a
          aria-label={`Open the question from ${formatDiscordTime(row.receivedAt)} in Discord`}
          className={`rounded-[4px] text-xs font-medium text-ink underline decoration-trace-strong underline-offset-2 hover:decoration-ink ${focusRing}`}
          href={row.messageLink}
          rel="noopener noreferrer"
          target="_blank"
        >
          Open
        </a>
      </td>
    </tr>
  );
}

/** The 24 h and 7 d summaries and the latest questions (D-28); never message text. */
export function DiscordActivity() {
  const activity = useDiscordListing("activity", loadActivity);
  const id = useId();
  const data = activity.data;
  return (
    <section aria-labelledby={`${id}-heading`} className={discordCardClass} data-testid="discord-activity">
      <div className={cardBodyClass}>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <h2 className={sectionHeadingClass} id={`${id}-heading`}>Activity</h2>
          <UiV2Button busy={activity.loading && Boolean(data)} disabled={activity.loading} onClick={activity.reload} type="button">
            Refresh
          </UiV2Button>
        </div>
        {activity.loading && !data ? <p className="text-xs text-ink-muted" role="status">Loading activity…</p> : null}
        {activity.error ? (
          <p className={`${alertClass} flex flex-wrap items-center gap-2`} role="alert">
            <span className="min-w-0 flex-1">{activity.error}</span>
            <UiV2Button onClick={activity.reload} type="button">Try again</UiV2Button>
          </p>
        ) : null}
        {data ? (
          <>
            <div className="grid min-w-0 gap-6 sm:grid-cols-2">
              <StatsColumn label="Last 24 hours" stats={data.last24h} />
              <StatsColumn label="Last 7 days" stats={data.last7d} />
            </div>
            <div className="min-w-0">
              <h3 className="text-xs font-semibold text-ink-secondary">Latest questions</h3>
              {data.rows.length === 0 ? (
                <p className="mt-2 text-xs text-ink-muted">No questions yet.</p>
              ) : (
                <div className="relative mt-2 min-w-0 overflow-x-auto rounded-[10px] border border-trace-subtle" data-testid="discord-activity-rows" tabIndex={0}>
                  <table className="w-full min-w-[36rem] text-left text-xs leading-5">
                    <caption className="sr-only">The latest {data.rows.length} Discord questions</caption>
                    <thead className="text-metadata font-semibold uppercase tracking-[0.06em] text-ink-muted">
                      <tr>
                        <th className="px-3 py-2 font-semibold" scope="col">Time</th>
                        <th className="px-3 py-2 font-semibold" scope="col">Author</th>
                        <th className="px-3 py-2 font-semibold" scope="col">Channel</th>
                        <th className="px-3 py-2 text-right font-semibold" scope="col">Latency</th>
                        <th className="px-3 py-2 font-semibold" scope="col">Outcome</th>
                        <th className="px-3 py-2 font-semibold" scope="col"><span className="sr-only">Message</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((row) => <ActivityRow key={row.questionMessageId} row={row} />)}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
      <p className={`${cardFooterClass} ${footerNoteClass}`}>Requests are kept for 90 days. Message text is never stored here.</p>
    </section>
  );
}
