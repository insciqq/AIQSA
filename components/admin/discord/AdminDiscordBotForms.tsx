"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { requestDiscordAssistants, requestDiscordChannels, requestDiscordGuilds } from "@/components/admin/discord/adminDiscordApi";
import {
  alertClass,
  cardBodyClass,
  cardFooterClass,
  discordCardClass,
  DiscordSectionLink,
  DiscordStatePill,
  fieldErrorClass,
  fieldLabelClass,
  footerNoteClass,
  helpTextClass,
  sectionHeadingClass,
  selectClass,
  type DiscordNavigate
} from "@/components/admin/discord/discordAdminParts";
import {
  discordChannelGroups,
  discordChannelsDirty,
  discordLimitsDirty,
  discordLimitsDraft,
  discordTokenError,
  parseDiscordCallNames,
  parseDiscordIds,
  parseDiscordLimits,
  type DiscordChannelsDraft,
  type DiscordLimitsDraft
} from "@/components/admin/discord/discordAdminView";
import type { AdminDiscordController } from "@/components/admin/discord/useAdminDiscordController";
import { useDiscordListing } from "@/components/admin/discord/useDiscordListing";
import { UiV2Button, UiV2Switch } from "@/components/ui-v2";
import { DISCORD_CALL_NAMES_MAX, DISCORD_TEST_IDS_MAX, type DiscordAdminState, type DiscordLimits } from "@/lib/contracts/discord";
import { useId, useState, type FormEvent } from "react";

type FormProps = Readonly<{ controller: AdminDiscordController; discord: DiscordAdminState }>;

type Feedback = Readonly<{ ok: boolean; text: string }> | null;

function FormFeedback({ feedback, testId }: Readonly<{ feedback: Feedback; testId: string }>) {
  if (!feedback) return null;
  return feedback.ok
    ? <p className="text-xs leading-5 text-positive" data-testid={testId} role="status">{feedback.text}</p>
    : <p className={alertClass} data-testid={testId} role="alert">{feedback.text}</p>;
}

function onSubmit(run: () => Promise<void>) {
  return (event: FormEvent) => {
    event.preventDefault();
    void run();
  };
}

const loadGuilds = () => requestDiscordGuilds();
const loadChannels = (guildId: string) => requestDiscordChannels(guildId);
const loadAssistants = () => requestDiscordAssistants();

function messageContentOn(discord: DiscordAdminState): boolean | null {
  const item = discord.setup.items.find((candidate) => candidate.code === "discord_message_content_disabled");
  return item ? item.status === "ok" : null;
}

/**
 * The write-only token: the stored token never reaches the browser, the field
 * starts empty and clears once Discord accepted a new one.
 */
export function DiscordTokenForm({ controller, discord }: FormProps) {
  const [token, setToken] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const id = useId();
  const busy = controller.state.busy;
  const messageContent = messageContentOn(discord);

  const submit = async () => {
    if (busy) return;
    const error = discordTokenError(token);
    setFieldError(error);
    setFeedback(null);
    if (error) {
      document.getElementById(id)?.focus();
      return;
    }
    const outcome = await controller.actions.testAndSave(token);
    if (outcome.ok) {
      setToken("");
      setFeedback({ ok: true, text: "Bot found. The token is saved." });
    } else if (outcome.message) {
      setFeedback({ ok: false, text: outcome.message });
    }
  };

  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  return (
    <form aria-labelledby={`${id}-heading`} className={discordCardClass} data-testid="discord-token-form" onSubmit={onSubmit(submit)}>
      <div className={cardBodyClass}>
        <h2 className={sectionHeadingClass} id={`${id}-heading`}>Bot</h2>
        {discord.bot ? (
          <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink" data-testid="discord-bot-identity">
            <span className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">@{discord.bot.username}</span>
            {messageContent === null ? null : (
              <span className={`text-xs ${messageContent ? "text-ink-muted" : "text-critical"}`}>
                Message Content: {messageContent ? "on" : "off"}
              </span>
            )}
          </p>
        ) : null}
        <div className="min-w-0">
          <label className={fieldLabelClass} htmlFor={id}>Bot token</label>
          <input
            aria-describedby={[helpId, fieldError ? errorId : null].filter(Boolean).join(" ")}
            aria-invalid={fieldError ? true : undefined}
            autoComplete="new-password"
            className={`${inputClass} sm:max-w-[32rem]`}
            data-discord-focus="token"
            data-testid="discord-token-input"
            disabled={busy !== null}
            id={id}
            onChange={(event) => {
              setToken(event.currentTarget.value);
              setFieldError(null);
              setFeedback(null);
            }}
            placeholder={discord.tokenConfigured ? "••••••••" : undefined}
            spellCheck={false}
            type="password"
            value={token}
          />
          <span className={helpTextClass} id={helpId}>
            In the Discord Developer Portal, open the application, turn on Message Content Intent under Bot and paste the bot
            token here.{" "}
            {discord.tokenConfigured
              ? "A token is stored and never shown here; paste a new one to replace it."
              : "Stored encrypted and never shown again."}
          </span>
          {fieldError ? <span className={fieldErrorClass} id={errorId}>{fieldError}</span> : null}
        </div>
        <FormFeedback feedback={feedback} testId="discord-test-result" />
      </div>
      <div className={cardFooterClass}>
        <UiV2Button busy={busy === "test"} data-testid="discord-test-and-save" disabled={busy !== null} tone="primary" type="submit">
          Test &amp; Save
        </UiV2Button>
        <span className={footerNoteClass}>AIQSA asks Discord for the bot first. If Discord does not accept the token, the current token stays.</span>
      </div>
    </form>
  );
}

/** The one server the bot answers in, chosen from the servers the bot is in. */
export function DiscordServerForm({ controller, discord }: FormProps) {
  const guilds = useDiscordListing(discord.bot ? `bot:${discord.bot.userId}` : null, loadGuilds);
  const [draft, setDraft] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const id = useId();
  const busy = controller.state.busy;
  const selected = draft ?? discord.guild?.id ?? "";
  const options = guilds.data?.guilds ?? [];
  const storedMissing = discord.guild && !options.some((guild) => guild.id === discord.guild!.id);
  const dirty = selected !== "" && selected !== (discord.guild?.id ?? "");

  const save = async () => {
    if (busy || !dirty) return;
    setFeedback(null);
    const outcome = await controller.actions.setGuild(selected);
    if (outcome.ok) setDraft(null);
    else if (outcome.message) setFeedback({ ok: false, text: outcome.message });
  };

  return (
    <form aria-labelledby={`${id}-heading`} className={discordCardClass} data-testid="discord-server-form" onSubmit={onSubmit(save)}>
      <div className={cardBodyClass}>
        <h2 className={sectionHeadingClass} id={`${id}-heading`}>Server</h2>
        <div className="min-w-0">
          <label className={fieldLabelClass} htmlFor={id}>Discord server</label>
          <select
            aria-describedby={`${id}-help`}
            className={selectClass}
            data-discord-focus="guild"
            data-testid="discord-guild-select"
            disabled={busy !== null || !discord.bot || guilds.loading}
            id={id}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setFeedback(null);
            }}
            value={selected}
          >
            <option disabled value="">{guilds.loading ? "Loading servers…" : "Choose a server"}</option>
            {storedMissing ? <option value={discord.guild!.id}>{discord.guild!.name}</option> : null}
            {options.map((guild) => <option key={guild.id} value={guild.id}>{guild.name}</option>)}
          </select>
          <span className={helpTextClass} id={`${id}-help`}>
            {!discord.bot
              ? "Save a bot token first."
              : guilds.data && options.length === 0
                ? "The bot is in no server yet. Invite it with the OAuth2 URL Generator (scope bot), then reload this list."
                : "The bot answers only in this server and in direct messages from its members. Channel choices belong to one server."}
          </span>
          {guilds.error ? (
            <p className={`${alertClass} mt-2 flex flex-wrap items-center gap-2`} role="alert">
              <span className="min-w-0 flex-1">{guilds.error}</span>
              <UiV2Button onClick={guilds.reload} type="button">Try again</UiV2Button>
            </p>
          ) : null}
        </div>
        <FormFeedback feedback={feedback} testId="discord-server-result" />
      </div>
      <div className={cardFooterClass}>
        <UiV2Button busy={busy === "guild"} data-testid="discord-save-guild" disabled={busy !== null || !dirty} tone="primary" type="submit">
          Save server
        </UiV2Button>
        {discord.bot ? (
          <UiV2Button disabled={guilds.loading} onClick={guilds.reload} type="button">Reload servers</UiV2Button>
        ) : null}
      </div>
    </form>
  );
}

/** Only listed or all except listed, picked by name; ids are what is saved. */
export function DiscordChannelsForm({ controller, discord }: FormProps) {
  const channels = useDiscordListing(discord.guild?.id ?? null, loadChannels);
  const [draft, setDraft] = useState<DiscordChannelsDraft | null>(null);
  const [query, setQuery] = useState("");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const id = useId();
  const busy = controller.state.busy;
  const current: DiscordChannelsDraft = draft ?? { channelIds: discord.channels.map((channel) => channel.id), mode: discord.channelMode };
  const selected = new Set(current.channelIds);
  const dirty = discordChannelsDirty(current, discord);
  const options = channels.data?.channels ?? [];
  const groups = discordChannelGroups(options, query);
  const visible = new Set(options.map((channel) => channel.id));
  const hidden = channels.data
    ? current.channelIds.filter((channelId) => !visible.has(channelId))
      .map((channelId) => ({ id: channelId, name: discord.channels.find((channel) => channel.id === channelId)?.name ?? null }))
    : [];

  const toggle = (channelId: string, on: boolean) => {
    const channelIds = on ? [...current.channelIds, channelId] : current.channelIds.filter((value) => value !== channelId);
    setDraft({ channelIds, mode: current.mode });
    setFeedback(null);
  };

  const save = async () => {
    if (busy || !dirty) return;
    setFeedback(null);
    const outcome = await controller.actions.setChannels({ channelIds: current.channelIds, mode: current.mode });
    if (outcome.ok) setDraft(null);
    else if (outcome.message) setFeedback({ ok: false, text: outcome.message });
  };

  const summary = current.mode === "only_listed"
    ? current.channelIds.length === 0
      ? "No channel chosen: the bot answers in no channel."
      : `The bot answers in ${current.channelIds.length === 1 ? "1 channel" : `${current.channelIds.length} channels`}.`
    : current.channelIds.length === 0
      ? "The bot answers in every channel it can see."
      : `The bot answers everywhere except ${current.channelIds.length === 1 ? "1 channel" : `${current.channelIds.length} channels`}.`;

  return (
    <form aria-labelledby={`${id}-heading`} className={discordCardClass} data-testid="discord-channels-form" onSubmit={onSubmit(save)}>
      <div className={cardBodyClass}>
        <h2 className={sectionHeadingClass} id={`${id}-heading`}>Channels</h2>
        <fieldset aria-labelledby={`${id}-heading`} className="grid min-w-0 gap-3" disabled={busy !== null || !discord.guild}>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {([["only_listed", "Only listed"], ["all_except", "All except listed"]] as const).map(([mode, label]) => (
              <label className="flex items-center gap-2 text-sm text-ink" key={mode}>
                <input
                  checked={current.mode === mode}
                  className="size-4 shrink-0 accent-proof"
                  data-testid={`discord-channel-mode-${mode}`}
                  name={`${id}-mode`}
                  onChange={() => {
                    setDraft({ channelIds: current.channelIds, mode });
                    setFeedback(null);
                  }}
                  type="radio"
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          {discord.guild ? (
            <div className="min-w-0">
              <label className={fieldLabelClass} htmlFor={`${id}-filter`}>Find a channel</label>
              <input
                className={`${inputClass} sm:max-w-[24rem]`}
                id={`${id}-filter`}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Channel name"
                type="search"
                value={query}
              />
              <div
                aria-busy={channels.loading || undefined}
                className="mt-2 max-h-72 min-w-0 overflow-y-auto overscroll-contain rounded-[10px] border border-trace-subtle px-3 py-2"
                data-testid="discord-channel-list"
              >
                {channels.loading ? <p className="py-2 text-xs text-ink-muted" role="status">Loading channels…</p> : null}
                {channels.error ? (
                  <p className="flex flex-wrap items-center gap-2 py-2 text-xs text-critical" role="alert">
                    <span className="min-w-0 flex-1">{channels.error}</span>
                    <UiV2Button onClick={channels.reload} type="button">Try again</UiV2Button>
                  </p>
                ) : null}
                {channels.data && groups.length === 0 ? (
                  <p className="py-2 text-xs text-ink-muted">{query ? "No channel matches." : "The bot sees no channel in this server."}</p>
                ) : null}
                {hidden.length > 0 ? (
                  <div className="py-1" role="group" aria-label="Not visible to the bot">
                    <p className="pb-1 pt-2 text-metadata font-semibold uppercase tracking-[0.06em] text-caution">Not visible to the bot</p>
                    {hidden.map((channel) => (
                      <label className="flex min-h-8 min-w-0 items-center gap-2 text-sm text-ink" key={channel.id}>
                        <input
                          checked
                          className="size-4 shrink-0 accent-proof"
                          onChange={() => toggle(channel.id, false)}
                          type="checkbox"
                        />
                        <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                          {channel.name ? `#${channel.name}` : "Unknown channel"} <span className="text-xs text-ink-muted">{channel.id}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : null}
                {groups.map((group) => (
                  <div className="py-1" key={group.id ?? "none"} role="group" aria-label={group.name ?? "No category"}>
                    {group.name ? (
                      <p className="pb-1 pt-2 text-metadata font-semibold uppercase tracking-[0.06em] text-ink-muted">{group.name}</p>
                    ) : null}
                    {group.channels.map((channel) => (
                      <label className="flex min-h-8 min-w-0 items-center gap-2 text-sm text-ink" key={channel.id}>
                        <input
                          checked={selected.has(channel.id)}
                          className="size-4 shrink-0 accent-proof"
                          onChange={(event) => toggle(channel.id, event.currentTarget.checked)}
                          type="checkbox"
                        />
                        <span className="min-w-0 break-words [overflow-wrap:anywhere]">#{channel.name}</span>
                        {channel.kind !== "text" ? <span className="shrink-0 text-xs text-ink-muted">{channel.kind}</span> : null}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs leading-5 text-ink-muted">Choose a server first.</p>
          )}
          <p className="text-xs leading-5 text-ink-muted">Threads and forum posts follow their channel.</p>
        </fieldset>
        <FormFeedback feedback={feedback} testId="discord-channels-result" />
      </div>
      <div className={cardFooterClass}>
        <UiV2Button busy={busy === "channels"} data-testid="discord-save-channels" disabled={busy !== null || !dirty} tone="primary" type="submit">
          Save channels
        </UiV2Button>
        {dirty ? (
          <UiV2Button disabled={busy !== null} onClick={() => { setDraft(null); setFeedback(null); }} type="button">Discard</UiV2Button>
        ) : null}
        <span className={footerNoteClass} role="status">{dirty ? `Unsaved. ${summary}` : summary}</span>
      </div>
    </form>
  );
}

/** Names that address the bot when a channel or thread message starts with one (PRD O-37). */
export function DiscordCallNamesForm({ controller, discord }: FormProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const id = useId();
  const busy = controller.state.busy;
  const stored = discord.callNames.join("\n");
  const text = draft ?? stored;
  const parsed = parseDiscordCallNames(text);
  const dirty = !parsed.ok || parsed.names.join("\n") !== stored;

  const save = async () => {
    if (busy || !dirty) return;
    setFeedback(null);
    if (!parsed.ok) {
      setError(parsed.message);
      document.getElementById(`${id}-names`)?.focus();
      return;
    }
    const outcome = await controller.actions.setCallNames(parsed.names);
    if (outcome.ok) setDraft(null);
    else if (outcome.message) setFeedback({ ok: false, text: outcome.message });
  };

  return (
    <form aria-labelledby={`${id}-heading`} className={discordCardClass} data-testid="discord-call-names-form" onSubmit={onSubmit(save)}>
      <div className={cardBodyClass}>
        <div>
          <h2 className={sectionHeadingClass} id={`${id}-heading`}>Call names</h2>
          <p className="mt-1 text-xs leading-5 text-ink-muted" id={`${id}-help`}>
            A message that starts with one of these names, then a comma, colon, space or dash, counts as addressing the bot in
            channels and threads. Direct messages are always answered.
          </p>
        </div>
        <div className="min-w-0">
          <label className={fieldLabelClass} htmlFor={`${id}-names`}>Names</label>
          <textarea
            aria-describedby={`${id}-help ${id}-format${error ? ` ${id}-error` : ""}`}
            aria-invalid={error ? true : undefined}
            className={`${inputClass} min-h-[5.5rem] py-2 text-sm`}
            data-testid="discord-call-names"
            disabled={busy !== null}
            id={`${id}-names`}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setError(null);
              setFeedback(null);
            }}
            rows={3}
            spellCheck={false}
            value={text}
          />
          {error ? <span className={fieldErrorClass} id={`${id}-error`}>{error}</span> : null}
          <span className={helpTextClass} id={`${id}-format`}>
            One name per line or separated by commas, up to {DISCORD_CALL_NAMES_MAX}. Empty: only mentions and replies ask the bot.
          </span>
        </div>
        <FormFeedback feedback={feedback} testId="discord-call-names-result" />
      </div>
      <div className={cardFooterClass}>
        <UiV2Button busy={busy === "call_names"} data-testid="discord-save-call-names" disabled={busy !== null || !dirty} tone="primary" type="submit">
          Save call names
        </UiV2Button>
        {dirty ? (
          <UiV2Button disabled={busy !== null} onClick={() => { setDraft(null); setError(null); setFeedback(null); }} type="button">Discard</UiV2Button>
        ) : null}
      </div>
    </form>
  );
}

export function DiscordDirectMessages({ controller, discord }: FormProps) {
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const busy = controller.state.busy;
  return (
    <section aria-labelledby={`${id}-heading`} className={discordCardClass} data-testid="discord-direct-messages">
      <div className="grid min-w-0 gap-3 px-5 py-4">
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className={sectionHeadingClass} id={`${id}-heading`}>Direct messages</h2>
            <p className="mt-1 text-xs leading-5 text-ink-muted" id={`${id}-help`}>
              Members of the server can message the bot directly. One conversation per person continues as one chat.
            </p>
          </div>
          <UiV2Switch
            aria-describedby={`${id}-help`}
            checked={discord.dmEnabled}
            data-testid="discord-dm-switch"
            disabled={busy !== null}
            label="Answer direct messages"
            onChange={(next) => {
              setError(null);
              void controller.actions.setDirectMessages(next).then((outcome) => {
                if (!outcome.ok && outcome.message) setError(outcome.message);
              });
            }}
          />
        </div>
        {error ? <p className={alertClass} role="alert">{error}</p> : null}
      </div>
    </section>
  );
}

/** The service account Discord runs belong to, and the Assistant that answers. */
export function DiscordAgentForm({
  controller,
  discord,
  onNavigate
}: FormProps & Readonly<{ onNavigate: DiscordNavigate }>) {
  const account = discord.serviceAccount;
  const assistants = useDiscordListing(account.status === "missing" ? null : `account:${account.userId ?? ""}`, loadAssistants);
  const [draft, setDraft] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const id = useId();
  const busy = controller.state.busy;
  const selected = draft ?? discord.assistant?.id ?? "";
  const options = assistants.data?.assistants ?? [];
  const storedMissing = discord.assistant && assistants.data && !options.some((assistant) => assistant.id === discord.assistant!.id);
  const dirty = selected !== "" && selected !== (discord.assistant?.id ?? "");

  const save = async () => {
    if (busy || !dirty) return;
    setFeedback(null);
    const outcome = await controller.actions.setAssistant(selected);
    if (outcome.ok) setDraft(null);
    else if (outcome.message) setFeedback({ ok: false, text: outcome.message });
  };

  return (
    <form aria-labelledby={`${id}-heading`} className={discordCardClass} data-testid="discord-agent-form" onSubmit={onSubmit(save)}>
      <div className={cardBodyClass}>
        <h2 className={sectionHeadingClass} id={`${id}-heading`}>Service account and Assistant</h2>
        <div className="grid min-w-0 gap-2" data-testid="discord-service-account">
          <p className={fieldLabelClass}>Service account</p>
          {account.status === "missing" ? (
            <>
              <p className="text-xs leading-5 text-ink-muted">
                Discord runs belong to one service account named Discord. It cannot sign in; its groups give it models, MCP
                servers and budgets.
              </p>
              <div>
                <UiV2Button
                  busy={busy === "service_account"}
                  data-testid="discord-create-service-account"
                  disabled={busy !== null}
                  onClick={() => {
                    setAccountError(null);
                    void controller.actions.createServiceAccount().then((outcome) => {
                      if (!outcome.ok && outcome.message) setAccountError(outcome.message);
                    });
                  }}
                  type="button"
                >
                  Create service account
                </UiV2Button>
              </div>
            </>
          ) : (
            <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink">
              <span className="font-medium">Discord</span>
              <DiscordStatePill tone={account.status === "active" ? "ok" : "critical"}>
                {account.status === "active" ? "Active" : "Deactivated"}
              </DiscordStatePill>
              {account.userId ? (
                <DiscordSectionLink onNavigate={onNavigate} resource={account.userId} section="users" testId="discord-service-account-link">
                  Open user page
                </DiscordSectionLink>
              ) : null}
            </p>
          )}
          {account.status === "inactive" ? (
            <p className="text-xs leading-5 text-critical">The service account is deactivated. Activate it on its user page.</p>
          ) : null}
          {accountError ? <p className={alertClass} role="alert">{accountError}</p> : null}
        </div>
        <div className="min-w-0">
          <label className={fieldLabelClass} htmlFor={id}>Assistant</label>
          <select
            aria-describedby={`${id}-help`}
            className={selectClass}
            data-discord-focus="assistant"
            data-testid="discord-assistant-select"
            disabled={busy !== null || account.status === "missing" || assistants.loading}
            id={id}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setFeedback(null);
            }}
            value={selected}
          >
            <option disabled value="">{assistants.loading ? "Loading Assistants…" : "Choose an Assistant"}</option>
            {storedMissing ? <option value={discord.assistant!.id}>{`${discord.assistant!.name} (not available)`}</option> : null}
            {options.map((assistant) => <option key={assistant.id} value={assistant.id}>{assistant.name}</option>)}
          </select>
          <span className={helpTextClass} id={`${id}-help`}>
            {account.status === "missing"
              ? "Create the service account first."
              : "Its model, Search and MCP servers answer every Discord question. Only Assistants the service account can use are listed."}
          </span>
          {assistants.error ? (
            <p className={`${alertClass} mt-2 flex flex-wrap items-center gap-2`} role="alert">
              <span className="min-w-0 flex-1">{assistants.error}</span>
              <UiV2Button onClick={assistants.reload} type="button">Try again</UiV2Button>
            </p>
          ) : null}
          {discord.assistant ? (
            <p className="mt-1.5">
              <DiscordSectionLink onNavigate={onNavigate} resource={discord.assistant.id} section="assistants">Open Assistant</DiscordSectionLink>
            </p>
          ) : null}
        </div>
        <FormFeedback feedback={feedback} testId="discord-assistant-result" />
      </div>
      <div className={cardFooterClass}>
        <UiV2Button busy={busy === "assistant"} data-testid="discord-save-assistant" disabled={busy !== null || !dirty} tone="primary" type="submit">
          Save Assistant
        </UiV2Button>
      </div>
    </form>
  );
}

const LIMIT_FIELDS: readonly Readonly<{ field: keyof DiscordLimits; help: string; label: string }>[] = [
  { field: "perAuthorHourly", help: "Questions one person can ask in an hour.", label: "Per author per hour" },
  { field: "perAuthorDaily", help: "Questions one person can ask in a day.", label: "Per author per day" },
  { field: "perThreadHourly", help: "Questions one thread can get in an hour.", label: "Per thread per hour" },
  { field: "parallelThreads", help: "Threads answered at the same time; others wait their turn.", label: "Parallel threads" }
];

export function DiscordLimitsForm({ controller, discord }: FormProps) {
  // Only the fields the administrator typed in; the others follow the server, also after a reload.
  const [draft, setDraft] = useState<Partial<DiscordLimitsDraft> | null>(null);
  const [fieldError, setFieldError] = useState<Readonly<{ field: keyof DiscordLimits; message: string }> | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const id = useId();
  const busy = controller.state.busy;
  const current: DiscordLimitsDraft = { ...discordLimitsDraft(discord.limits), ...draft };
  const dirty = discordLimitsDirty(current, discord.limits);

  const save = async () => {
    if (busy || !dirty) return;
    setFeedback(null);
    const parsed = parseDiscordLimits(current);
    if (!parsed.ok) {
      setFieldError({ field: parsed.field, message: parsed.message });
      document.getElementById(`${id}-${parsed.field}`)?.focus();
      return;
    }
    const outcome = await controller.actions.setLimits(parsed.limits);
    if (outcome.ok) setDraft(null);
    else if (outcome.message) setFeedback({ ok: false, text: outcome.message });
  };

  return (
    <form aria-labelledby={`${id}-heading`} className={discordCardClass} data-testid="discord-limits-form" onSubmit={onSubmit(save)}>
      <div className={cardBodyClass}>
        <div>
          <h2 className={sectionHeadingClass} id={`${id}-heading`}>Limits</h2>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            Over a limit, the question is refused with a short note. Monthly budgets of the service account still apply.
          </p>
        </div>
        <fieldset className="grid min-w-0 gap-4 sm:grid-cols-2" disabled={busy !== null}>
          {LIMIT_FIELDS.map(({ field, help, label }) => {
            const error = fieldError?.field === field ? fieldError.message : null;
            return (
              <div className="min-w-0" key={field}>
                <label className={fieldLabelClass} htmlFor={`${id}-${field}`}>{label}</label>
                <input
                  aria-describedby={`${id}-${field}-help${error ? ` ${id}-${field}-error` : ""}`}
                  aria-invalid={error ? true : undefined}
                  className={`${inputClass} sm:max-w-[10rem]`}
                  data-testid={`discord-limit-${field}`}
                  id={`${id}-${field}`}
                  inputMode="numeric"
                  onChange={(event) => {
                    setDraft({ ...draft, [field]: event.currentTarget.value });
                    setFieldError(null);
                    setFeedback(null);
                  }}
                  value={current[field]}
                />
                <span className={helpTextClass} id={`${id}-${field}-help`}>{help}</span>
                {error ? <span className={fieldErrorClass} id={`${id}-${field}-error`}>{error}</span> : null}
              </div>
            );
          })}
        </fieldset>
        <FormFeedback feedback={feedback} testId="discord-limits-result" />
      </div>
      <div className={cardFooterClass}>
        <UiV2Button busy={busy === "limits"} data-testid="discord-save-limits" disabled={busy !== null || !dirty} tone="primary" type="submit">
          Save limits
        </UiV2Button>
        {dirty ? (
          <UiV2Button disabled={busy !== null} onClick={() => { setDraft(null); setFieldError(null); }} type="button">Discard</UiV2Button>
        ) : null}
      </div>
    </form>
  );
}

/** Bots whose messages in the listed channels are handled like people's, for end-to-end tests without people. */
export function DiscordTestModeForm({ controller, discord }: FormProps) {
  const [authors, setAuthors] = useState<string | null>(null);
  const [channels, setChannels] = useState<string | null>(null);
  const [error, setError] = useState<Readonly<{ field: "authors" | "channels"; message: string }> | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const id = useId();
  const busy = controller.state.busy;
  const authorsText = authors ?? discord.testAuthorIds.join("\n");
  const channelsText = channels ?? discord.testChannelIds.join("\n");
  const dirty = authorsText.trim() !== discord.testAuthorIds.join("\n") || channelsText.trim() !== discord.testChannelIds.join("\n");

  const save = async () => {
    if (busy || !dirty) return;
    setFeedback(null);
    const parsedAuthors = parseDiscordIds(authorsText);
    if (!parsedAuthors.ok) {
      setError({ field: "authors", message: parsedAuthors.message });
      document.getElementById(`${id}-authors`)?.focus();
      return;
    }
    const parsedChannels = parseDiscordIds(channelsText);
    if (!parsedChannels.ok) {
      setError({ field: "channels", message: parsedChannels.message });
      document.getElementById(`${id}-channels`)?.focus();
      return;
    }
    const outcome = await controller.actions.setTestAccess({ testAuthorIds: parsedAuthors.ids, testChannelIds: parsedChannels.ids });
    if (outcome.ok) {
      setAuthors(null);
      setChannels(null);
    } else if (outcome.message) {
      setFeedback({ ok: false, text: outcome.message });
    }
  };

  const field = (name: "authors" | "channels", label: string, value: string, set: (value: string) => void) => {
    const fieldError = error?.field === name ? error.message : null;
    return (
      <div className="min-w-0">
        <label className={fieldLabelClass} htmlFor={`${id}-${name}`}>{label}</label>
        <textarea
          aria-describedby={`${id}-ids-help${fieldError ? ` ${id}-${name}-error` : ""}`}
          aria-invalid={fieldError ? true : undefined}
          className={`${inputClass} min-h-[5.5rem] py-2 font-mono text-xs`}
          data-testid={`discord-test-${name}`}
          id={`${id}-${name}`}
          onChange={(event) => {
            set(event.currentTarget.value);
            setError(null);
            setFeedback(null);
          }}
          rows={3}
          spellCheck={false}
          value={value}
        />
        {fieldError ? <span className={fieldErrorClass} id={`${id}-${name}-error`}>{fieldError}</span> : null}
      </div>
    );
  };

  return (
    <form aria-labelledby={`${id}-heading`} className={discordCardClass} data-testid="discord-test-mode-form" onSubmit={onSubmit(save)}>
      <div className={cardBodyClass}>
        <div>
          <h2 className={sectionHeadingClass} id={`${id}-heading`}>Test mode</h2>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            Messages from these bots in these channels are handled like people&apos;s and marked as tests.
          </p>
        </div>
        <fieldset className="grid min-w-0 gap-4 sm:grid-cols-2" disabled={busy !== null}>
          {field("authors", "Test bot author ids", authorsText, setAuthors)}
          {field("channels", "Test channel ids", channelsText, setChannels)}
        </fieldset>
        <span className="-mt-2 text-xs leading-5 text-ink-muted" id={`${id}-ids-help`}>
          Discord ids, one per line, up to {DISCORD_TEST_IDS_MAX} each. Empty turns test mode off.
        </span>
        <FormFeedback feedback={feedback} testId="discord-test-mode-result" />
      </div>
      <div className={cardFooterClass}>
        <UiV2Button busy={busy === "test_access"} data-testid="discord-save-test-mode" disabled={busy !== null || !dirty} tone="primary" type="submit">
          Save test mode
        </UiV2Button>
        {dirty ? (
          <UiV2Button disabled={busy !== null} onClick={() => { setAuthors(null); setChannels(null); setError(null); }} type="button">Discard</UiV2Button>
        ) : null}
      </div>
    </form>
  );
}
