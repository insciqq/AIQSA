"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useBeforeUnloadGuard } from "@/components/app-shell/useBeforeUnloadGuard";
import { UiV2Button, UiV2Switch } from "@/components/ui-v2";
import { PROXY_LIMITS, PROXY_PROTOCOLS, type ProxyProtocol, type ProxySharedWire, type ProxyWire } from "@/lib/contracts/proxies";
import {
  checkProxy, createProxy, deleteProxy, listProxies, ProxyRequestError, updateProxy, type ProxyAudience, type ProxyLists
} from "./proxiesApi";
import {
  blankProxyDraft, proxyCreateInput, proxyDraftFrom, proxyDraftPortIsValid, proxyUpdateInput, rebaseProxyDraft, sameProxyDraft, type ProxyDraft
} from "./proxyDraft";
import { proxyFailureMessage } from "./proxyMessages";
import { SettingsSelectV2 } from "./SettingsSelectV2";

const PROTOCOL_LABELS: Readonly<Record<ProxyProtocol, string>> = { http: "HTTP", https: "HTTPS", socks5: "SOCKS5" };
const PROTOCOL_OPTIONS = PROXY_PROTOCOLS.map((value) => ({ label: PROTOCOL_LABELS[value], value }));

const COPY: Readonly<Record<ProxyAudience, Readonly<{ deleted: string; empty: string; intro: string; listLabel: string; removal: string }>>> = {
  administrator: {
    deleted: "Proxy deleted.",
    empty: "No proxies for everyone yet.",
    intro: "Proxies everyone on this installation can use. Members see a proxy's name, country and domain hints, never its address, login or password.",
    listLabel: "Proxies for everyone",
    removal: "Everyone's chats lose it at once. This cannot be undone."
  },
  personal: {
    deleted: "Proxy deleted.",
    empty: "No proxies yet. Add one here, or give the agent one in a chat.",
    intro: "A proxy lets the agent's browser, commands and page reading open a site from another address or country. Search, MCP and model traffic never use one.",
    listLabel: "Your proxies",
    removal: "Your chats lose it at once. This cannot be undone."
  }
};

const FIELD = "w-full min-w-0 rounded-lg border border-trace bg-answer-paper px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60";
const LABEL = "grid min-w-0 gap-1.5 text-xs font-medium text-ink-secondary";
const NOTE = "text-xs leading-5 text-ink-muted";

const failureCode = (error: unknown) => error instanceof ProxyRequestError ? error.code : "";
const formatDate = (value: string) => new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
const endpoint = (proxy: ProxyWire) => `${proxy.host.includes(":") ? `[${proxy.host}]` : proxy.host}:${proxy.port}`;
const hintsLine = (hints: readonly string[]) => hints.join(", ");

type ProxyForm = Readonly<{
  base: ProxyWire | null;
  discarding: boolean;
  draft: ProxyDraft;
  error: string | null;
  initial: ProxyDraft;
}>;

/**
 * One list for both owners: personal in Settings, the administrators' in the
 * Control Center. Add and edit open in place, because Settings is itself a modal.
 * A stored password never reaches this component: it knows only `hasPassword`.
 */
export function ProxyListPanel({ audience, onBusyChange, onDirtyChange }: Readonly<{
  audience: ProxyAudience;
  onBusyChange?(busy: boolean): void;
  onDirtyChange?(dirty: boolean): void;
}>) {
  const copy = COPY[audience];
  const [proxies, setProxies] = useState<readonly ProxyWire[]>([]);
  const [shared, setShared] = useState<readonly ProxySharedWire[]>([]);
  const [loadState, setLoadState] = useState<"failed" | "loading" | "ready">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<ProxyForm | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<Readonly<{ key: string }> | null>(null);
  const alive = useRef(false);
  const pending = useRef(false);
  const loads = useRef(0);
  const checks = useRef(new Map<string, AbortController>());
  const root = useRef<HTMLElement>(null);
  const focusDone = useRef<Readonly<{ key: string }> | null>(null);
  const dirty = form !== null && !sameProxyDraft(form.draft, form.initial);
  useBeforeUnloadGuard(dirty || busy);

  /** Focus targets carry `data-proxy-focus`, so moving focus needs no ref per row. */
  const focusTarget = (key: string) => [...(root.current?.querySelectorAll<HTMLElement>("[data-proxy-focus]") ?? [])]
    .find((element) => element.dataset.proxyFocus === key);
  const focusNext = (key: string) => setFocusRequest({ key });

  function showLists(lists: ProxyLists) {
    setProxies(lists.proxies);
    setShared(lists.shared);
  }
  /** Keeps the newest revision: a slow check must not bring back a row saved since. */
  function showRow(next: ProxyWire) {
    setProxies((rows) => rows.map((row) => row.id === next.id && row.version <= next.version ? next : row));
  }
  function setRowError(id: string, message: string | null) {
    setRowErrors((errors) => {
      const { [id]: _previous, ...rest } = errors;
      return message === null ? rest : { ...rest, [id]: message };
    });
  }

  async function load(signal?: AbortSignal) {
    const generation = ++loads.current;
    setLoadState("loading");
    setLoadError(null);
    try {
      const lists = await listProxies(audience, signal);
      if (!alive.current || generation !== loads.current) return;
      showLists(lists);
      setLoadState("ready");
    } catch (error) {
      if (!alive.current || generation !== loads.current || signal?.aborted) return;
      setLoadError(proxyFailureMessage(failureCode(error)));
      setLoadState("failed");
    }
  }

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const running = checks.current;
    queueMicrotask(() => { if (!controller.signal.aborted) void load(controller.signal); });
    return () => {
      alive.current = false;
      controller.abort();
      for (const check of running.values()) check.abort();
      running.clear();
    };
    // The audience of a mounted panel never changes: each surface mounts its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    // A busy control cannot take focus, so a request waits until the work ended.
    if (!focusRequest || busy || focusDone.current === focusRequest) return;
    focusDone.current = focusRequest;
    focusTarget(focusRequest.key)?.focus();
  }, [busy, focusRequest]);

  /** Reloads after a conflict or a missing row. Null when the list could not be read. */
  async function reload(): Promise<ProxyLists | null> {
    try {
      const lists = await listProxies(audience);
      if (alive.current) showLists(lists);
      return lists;
    } catch {
      return null;
    }
  }

  async function exclusive(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice(null);
    setListError(null);
    try {
      await work();
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  function openForm(base: ProxyWire | null) {
    const draft = base ? proxyDraftFrom(base) : blankProxyDraft;
    setForm({ base, discarding: false, draft, error: null, initial: draft });
    setDeleting(null);
    setNotice(null);
    focusNext("name");
  }
  function closeForm(focus?: string) {
    const opener = form?.base ? `edit:${form.base.id}` : "add";
    setForm(null);
    focusNext(focus ?? opener);
  }
  function requestCancel() {
    if (pending.current || !form) return;
    if (!dirty) { closeForm(); return; }
    setForm({ ...form, discarding: true });
    focusNext("keep-editing");
  }
  function change(patch: Partial<ProxyDraft>) {
    setForm((current) => current ? { ...current, draft: { ...current.draft, ...patch } } : current);
  }
  function refuse(message: string) {
    setForm((current) => current ? { ...current, error: message } : current);
    focusNext("form-error");
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!form || pending.current) return;
    const { base, draft, initial } = form;
    if (!proxyDraftPortIsValid(draft)) { refuse(proxyFailureMessage("proxy_port_invalid")); return; }
    const update = base ? proxyUpdateInput(draft, base) : null;
    if (base && update === null) { closeForm(`heading:${base.id}`); return; }
    setForm({ ...form, error: null });
    void exclusive(async () => {
      try {
        if (base) {
          const saved = await updateProxy(audience, base.id, update!);
          if (!alive.current) return;
          showRow(saved);
          setRowError(base.id, null);
          setForm(null);
          setNotice("Proxy saved. It works from the next message.");
          focusNext(`heading:${base.id}`);
        } else {
          const created = await createProxy(audience, proxyCreateInput(draft));
          if (!alive.current) return;
          setProxies((rows) => [...rows, created]);
          setForm(null);
          setNotice("Proxy saved. It works from the next message.");
          focusNext(`heading:${created.id}`);
        }
      } catch (error) {
        if (!alive.current) return;
        const code = failureCode(error);
        if (base && (code === "proxy_conflict" || code === "proxy_not_found")) {
          const lists = await reload();
          if (!alive.current) return;
          const latest = lists?.proxies.find((row) => row.id === base.id);
          if (lists && !latest) {
            setForm(null);
            setListError(`“${base.name}” no longer exists. Nothing was saved.`);
            focusNext("add");
            return;
          }
          if (latest) {
            const next = proxyDraftFrom(latest);
            setForm((current) => current ? { ...current, base: latest, draft: rebaseProxyDraft(current.draft, initial, latest), initial: next } : current);
          }
          refuse(latest ? proxyFailureMessage("proxy_conflict") : "This proxy was changed somewhere else, and its latest version could not be loaded. Try saving again.");
          return;
        }
        refuse(proxyFailureMessage(code));
      }
    });
  }

  /** A refused row action: a conflict or a missing row reloads the list and says so. */
  async function rowFailure(proxy: ProxyWire, error: unknown, conflict: string) {
    const code = failureCode(error);
    if (code !== "proxy_conflict" && code !== "proxy_not_found") { setRowError(proxy.id, proxyFailureMessage(code)); return; }
    const lists = await reload();
    if (!alive.current) return;
    if (lists && !lists.proxies.some((row) => row.id === proxy.id)) { setListError(`“${proxy.name}” no longer exists.`); focusNext("add"); return; }
    setRowError(proxy.id, lists ? conflict : "This proxy was changed somewhere else, and its latest version could not be loaded. Try again.");
  }

  function toggle(proxy: ProxyWire) {
    setRowError(proxy.id, null);
    void exclusive(async () => {
      try {
        const saved = await updateProxy(audience, proxy.id, { active: !proxy.active, expectedVersion: proxy.version });
        if (alive.current) showRow(saved);
      } catch (error) {
        if (alive.current) await rowFailure(proxy, error, "This proxy was changed somewhere else, so the switch was not changed. The latest version is shown.");
      }
      if (alive.current) focusNext(`switch:${proxy.id}`);
    });
  }

  function remove(proxy: ProxyWire) {
    void exclusive(async () => {
      try {
        await deleteProxy(audience, proxy.id, { expectedVersion: proxy.version });
        if (!alive.current) return;
        setProxies((rows) => rows.filter((row) => row.id !== proxy.id));
        setRowError(proxy.id, null);
        setDeleting(null);
        setNotice(copy.deleted);
        focusNext("add");
      } catch (error) {
        if (!alive.current) return;
        setDeleting(null);
        focusNext(`delete:${proxy.id}`);
        await rowFailure(proxy, error, "This proxy was changed somewhere else, so it was not deleted. The latest version is shown: look it over and delete it again if you still want to.");
      }
    });
  }

  async function check(proxy: ProxyWire) {
    if (checks.current.has(proxy.id)) return;
    const controller = new AbortController();
    checks.current.set(proxy.id, controller);
    setChecking((ids) => new Set(ids).add(proxy.id));
    setRowError(proxy.id, null);
    try {
      const checked = await checkProxy(audience, proxy.id, controller.signal);
      if (!alive.current) return;
      showRow(checked);
      if (checked.version !== proxy.version) setRowError(proxy.id, "This proxy changed during the check, so the result was not kept. Check it again.");
    } catch (error) {
      if (alive.current && !controller.signal.aborted) await rowFailure(proxy, error, "This proxy was changed somewhere else. The latest version is shown: check it again.");
    } finally {
      checks.current.delete(proxy.id);
      if (alive.current) {
        setChecking((ids) => { const next = new Set(ids); next.delete(proxy.id); return next; });
        // The button was disabled while it ran. Focus returns only if the person stayed there.
        const button = focusTarget(`check:${proxy.id}`);
        if (document.activeElement === document.body || document.activeElement === button) focusNext(`check:${proxy.id}`);
      }
    }
  }

  const locked = busy || form !== null;
  const atLimit = proxies.length >= PROXY_LIMITS.proxiesPerOwner;
  const renderForm = (current: ProxyForm) => <ProxyFormView audience={audience} busy={busy} form={current}
    onCancel={requestCancel} onChange={change} onDiscard={() => closeForm()} onKeepEditing={() => { setForm({ ...current, discarding: false }); focusNext("name"); }}
    onSubmit={save} />;

  return <section ref={root} className="v2-proxy-panel" aria-label="Proxies" data-testid={`proxy-list-${audience}`}>
    <p className="v2-proxy-intro">{copy.intro}</p>
    <div className="v2-proxy-toolbar">
      <UiV2Button data-proxy-focus="add" type="button" icon="plus" disabled={locked || loadState !== "ready" || atLimit} onClick={() => openForm(null)}>Add proxy</UiV2Button>
      {atLimit && loadState === "ready" ? <p className={NOTE}>{proxyFailureMessage("proxy_limit")}</p> : null}
    </div>
    {listError ? <p className="mt-3 break-words text-sm text-critical" role="alert">{listError}</p> : null}
    {notice ? <p className="mt-3 text-sm text-positive" role="status">{notice}</p> : null}
    {loadState === "loading" ? <p className="mt-4 text-sm text-ink-muted" role="status">Loading proxies…</p> : null}
    {loadState === "failed" ? <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-critical" role="alert">
      <p className="break-words">The proxies could not be loaded. {loadError}</p>
      <UiV2Button type="button" onClick={() => void load()}>Try again</UiV2Button>
    </div> : null}
    {form && !form.base ? renderForm(form) : null}
    {loadState === "ready" && proxies.length === 0 && !form ? <p className="mt-4 text-sm text-ink-muted">{copy.empty}</p> : null}
    {proxies.length > 0 ? <ul className="v2-proxy-list" aria-label={copy.listLabel}>
      {proxies.map((proxy) => form?.base?.id === proxy.id
        ? <li className="v2-proxy-row" key={proxy.id}>{renderForm(form)}</li>
        : <ProxyRow key={proxy.id} audience={audience} checking={checking.has(proxy.id)} confirmDelete={deleting === proxy.id} error={rowErrors[proxy.id] ?? null}
          locked={locked} proxy={proxy} onCheck={() => void check(proxy)} onCancelDelete={() => { setDeleting(null); focusNext(`delete:${proxy.id}`); }}
          onConfirmDelete={() => remove(proxy)} onDelete={() => { setDeleting(proxy.id); setNotice(null); focusNext(`keep:${proxy.id}`); }} onEdit={() => openForm(proxy)} onToggle={() => toggle(proxy)} />)}
    </ul> : null}
    {shared.length > 0 ? <>
      <h3 className="v2-settings-group-label">From your administrators</h3>
      <p className={NOTE}>You can use these by name. Only administrators can change them.</p>
      <ul className="v2-proxy-list" aria-label="Proxies from your administrators">
        {shared.map((proxy) => <SharedRow key={proxy.id} proxy={proxy} />)}
      </ul>
    </> : null}
  </section>;
}

function HintsLine({ hints }: Readonly<{ hints: readonly string[] }>) {
  return hints.length ? <p className="v2-proxy-text text-ink-secondary">Hints: {hintsLine(hints)}</p> : null;
}

function SharedRow({ proxy }: Readonly<{ proxy: ProxySharedWire }>) {
  const facts = [...(proxy.active ? [] : ["Off"]), ...(proxy.country ? [proxy.country] : [])];
  return <li className="v2-proxy-row">
    <div className="v2-proxy-copy">
      <h4 className="v2-proxy-name">{proxy.name}</h4>
      {facts.length ? <p className="v2-proxy-text text-ink-muted">{facts.join(" · ")}</p> : null}
      <HintsLine hints={proxy.domainHints} />
    </div>
  </li>;
}

function CheckLine({ checking, proxy }: Readonly<{ checking: boolean; proxy: ProxyWire }>) {
  const last = proxy.lastCheck;
  // A live region, so that a result is read out when a check ends.
  return <div aria-live="polite">
    {checking ? <p className="v2-proxy-text text-ink-muted">Checking…</p>
      : !last ? null
        : last.status === "ok"
          ? <p className="v2-proxy-text text-positive">Works. Sites see {last.exitAddress ?? "an unknown address"}. <span className="text-ink-muted">Checked {formatDate(last.checkedAt)}.</span></p>
          : <p className="v2-proxy-text text-critical">{proxyFailureMessage(last.status)} <span className="text-ink-muted">Checked {formatDate(last.checkedAt)}.</span></p>}
  </div>;
}

function ProxyRow({ audience, checking, confirmDelete, error, locked, onCancelDelete, onCheck, onConfirmDelete, onDelete, onEdit, onToggle, proxy }: Readonly<{
  audience: ProxyAudience;
  checking: boolean;
  confirmDelete: boolean;
  error: string | null;
  locked: boolean;
  onCancelDelete(): void;
  onCheck(): void;
  onConfirmDelete(): void;
  onDelete(): void;
  onEdit(): void;
  onToggle(): void;
  proxy: ProxyWire;
}>) {
  const facts = [
    ...(proxy.active ? [] : ["Off"]),
    `${PROTOCOL_LABELS[proxy.protocol]} ${endpoint(proxy)}`,
    ...(proxy.login ? [`Login ${proxy.login}`] : []),
    ...(proxy.hasPassword ? ["Password stored"] : []),
    ...(proxy.country ? [proxy.country] : [])
  ];
  return <li className="v2-proxy-row">
    <div className="v2-proxy-head">
      <div className="v2-proxy-copy">
        <h3 className="v2-proxy-name focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" data-proxy-focus={`heading:${proxy.id}`} tabIndex={-1}>{proxy.name}</h3>
        <p className="v2-proxy-text text-ink-muted">{facts.join(" · ")}</p>
        <HintsLine hints={proxy.domainHints} />
        <CheckLine checking={checking} proxy={proxy} />
        {error ? <p className="v2-proxy-text text-critical" role="alert">{error}</p> : null}
      </div>
      <span className="v2-proxy-switch">
        <UiV2Switch data-proxy-focus={`switch:${proxy.id}`} checked={proxy.active} disabled={locked} label={`Use ${proxy.name}`} onChange={onToggle} />
      </span>
    </div>
    {confirmDelete ? <div className="v2-proxy-actions" role="group" aria-label={`Delete ${proxy.name}`}
      onKeyDown={(event) => { if (event.key === "Escape" && !locked) { event.preventDefault(); event.stopPropagation(); onCancelDelete(); } }}>
      <p className="v2-proxy-confirm">Delete “{proxy.name}”? {COPY[audience].removal}</p>
      <UiV2Button type="button" tone="destructive" disabled={locked} onClick={onConfirmDelete}>Delete proxy</UiV2Button>
      <UiV2Button data-proxy-focus={`keep:${proxy.id}`} type="button" disabled={locked} onClick={onCancelDelete}>Keep proxy</UiV2Button>
    </div> : <div className="v2-proxy-actions">
      <UiV2Button data-proxy-focus={`check:${proxy.id}`} type="button" busy={checking} aria-label={`Check ${proxy.name}`} onClick={onCheck}>Check</UiV2Button>
      <UiV2Button data-proxy-focus={`edit:${proxy.id}`} type="button" disabled={locked} aria-label={`Edit ${proxy.name}`} onClick={onEdit}>Edit</UiV2Button>
      <UiV2Button data-proxy-focus={`delete:${proxy.id}`} type="button" disabled={locked} aria-label={`Delete ${proxy.name}`} onClick={onDelete}>Delete</UiV2Button>
    </div>}
  </li>;
}

function ProxyFormView({ audience, busy, form, onCancel, onChange, onDiscard, onKeepEditing, onSubmit }: Readonly<{
  audience: ProxyAudience;
  busy: boolean;
  form: ProxyForm;
  onCancel(): void;
  onChange(patch: Partial<ProxyDraft>): void;
  onDiscard(): void;
  onKeepEditing(): void;
  onSubmit(event: FormEvent): void;
}>) {
  const hintsNote = useId();
  const { base, discarding, draft, error, initial } = form;
  const passwordStored = base?.hasPassword === true;
  const addressChanged = draft.host.trim() !== initial.host || draft.port.trim() !== initial.port;
  const keepsPassword = passwordStored && !draft.removePassword && !draft.password;
  function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    // Settings closes on Escape: inside the form it belongs to the form.
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    if (discarding) onKeepEditing();
    else onCancel();
  }
  return <form className="v2-proxy-form" aria-label={base ? `Edit ${base.name}` : audience === "administrator" ? "Add a proxy for everyone" : "Add a proxy"} onSubmit={onSubmit} onKeyDown={onKeyDown}>
    <fieldset disabled={busy} className="v2-proxy-fields">
      <div className="v2-proxy-pair">
        <label className={LABEL}>Name
          <input data-proxy-focus="name" autoComplete="off" className={FIELD} maxLength={PROXY_LIMITS.nameMaxLength} required value={draft.name} onChange={(event) => onChange({ name: event.target.value })} />
        </label>
        <label className={LABEL}>Country
          <input autoComplete="off" className={FIELD} maxLength={2} placeholder="KZ" spellCheck={false} value={draft.country} onChange={(event) => onChange({ country: event.target.value })} />
        </label>
      </div>
      <div className={LABEL}><span>Protocol</span>
        <SettingsSelectV2 disabled={busy} label="Protocol" options={PROTOCOL_OPTIONS} value={draft.protocol} onChange={(protocol) => onChange({ protocol })} />
      </div>
      <div className="v2-proxy-pair">
        <label className={LABEL}>Host
          <input autoCapitalize="none" autoComplete="off" className={FIELD} placeholder="proxy.example.com" required spellCheck={false} value={draft.host} onChange={(event) => onChange({ host: event.target.value })} />
        </label>
        <label className={LABEL}>Port
          <input autoComplete="off" className={FIELD} inputMode="numeric" required value={draft.port} onChange={(event) => onChange({ port: event.target.value })} />
        </label>
      </div>
      {keepsPassword ? <p className={addressChanged ? "text-xs leading-5 text-caution" : NOTE}>Changing the address keeps the stored password, and the password then goes to the new address.</p> : null}
      <div className="v2-proxy-credentials">
        <label className={LABEL}>Login (optional)
          <input autoCapitalize="none" autoComplete="off" className={FIELD} spellCheck={false} value={draft.login} onChange={(event) => onChange({ login: event.target.value })} />
        </label>
        <label className={LABEL}>{passwordStored ? "New password" : "Password (optional)"}
          <input autoComplete="new-password" className={FIELD} disabled={draft.removePassword} type="password" value={draft.password} onChange={(event) => onChange({ password: event.target.value })} />
        </label>
      </div>
      {passwordStored ? <div className="v2-proxy-password-state">
        <p className={NOTE}>{draft.removePassword ? "The stored password will be removed when you save." : "A password is stored. Leave the field empty to keep it."}</p>
        <UiV2Button type="button" onClick={() => onChange(draft.removePassword ? { removePassword: false } : { password: "", removePassword: true })}>
          {draft.removePassword ? "Keep stored password" : "Remove stored password"}
        </UiV2Button>
      </div> : base ? <p className={NOTE}>No password is stored.</p> : null}
      <label className={LABEL}>Domain hints (optional)
        <textarea aria-describedby={hintsNote} autoCapitalize="none" autoComplete="off" className={FIELD} rows={3} spellCheck={false} value={draft.hints} onChange={(event) => onChange({ hints: event.target.value })} />
      </label>
      <p className={NOTE} id={hintsNote}>Zones or domains this proxy suits, one per line, such as .kz or ozon.ru. A hint suggests where to use the proxy and never limits it.</p>
      {error ? <p className="break-words text-sm text-critical focus-visible:outline-none" data-proxy-focus="form-error" role="alert" tabIndex={-1}>{error}</p> : null}
      {discarding ? <div className="v2-proxy-actions" role="group" aria-label="Discard changes">
        <p className="v2-proxy-confirm">Discard your changes to this proxy?</p>
        <UiV2Button type="button" tone="destructive" onClick={onDiscard}>Discard changes</UiV2Button>
        <UiV2Button data-proxy-focus="keep-editing" type="button" onClick={onKeepEditing}>Keep editing</UiV2Button>
      </div> : <div className="v2-proxy-actions">
        <UiV2Button type="submit" tone="primary">{busy ? "Saving…" : "Save proxy"}</UiV2Button>
        <UiV2Button type="button" onClick={onCancel}>Cancel</UiV2Button>
      </div>}
    </fieldset>
  </form>;
}
