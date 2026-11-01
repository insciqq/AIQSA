import { isProxyPort, type ProxyProtocol, type ProxyUpdateInput, type ProxyWire, type ProxyWriteInput } from "@/lib/contracts/proxies";

/** What the form holds. A stored password is never in it: `password` is only what was typed now. */
export type ProxyDraft = Readonly<{
  country: string;
  hints: string;
  host: string;
  login: string;
  name: string;
  password: string;
  port: string;
  protocol: ProxyProtocol;
  removePassword: boolean;
}>;

export const blankProxyDraft: ProxyDraft = Object.freeze({
  country: "",
  hints: "",
  host: "",
  login: "",
  name: "",
  password: "",
  port: "",
  protocol: "http",
  removePassword: false
});

export function proxyDraftFrom(proxy: ProxyWire): ProxyDraft {
  return { country: proxy.country ?? "", hints: proxy.domainHints.join("\n"), host: proxy.host, login: proxy.login ?? "", name: proxy.name,
    password: "", port: String(proxy.port), protocol: proxy.protocol, removePassword: false };
}

export function sameProxyDraft(left: ProxyDraft, right: ProxyDraft): boolean {
  return (Object.keys(left) as (keyof ProxyDraft)[]).every((key) => left[key] === right[key]);
}

/** Hints as plain text: one per line, commas and spaces also separate. The server checks each. */
export function parseProxyHints(text: string): readonly string[] {
  return text.split(/[\s,;]+/u).filter(Boolean);
}

/** The typed port, or NaN, which is no port. */
const portOf = (draft: ProxyDraft) => /^\d+$/u.test(draft.port.trim()) ? Number(draft.port.trim()) : Number.NaN;
const countryOf = (draft: ProxyDraft) => draft.country.trim().toUpperCase() || null;

export function proxyDraftPortIsValid(draft: ProxyDraft): boolean {
  return isProxyPort(portOf(draft));
}

export function proxyCreateInput(draft: ProxyDraft): ProxyWriteInput {
  const country = countryOf(draft);
  return { domainHints: parseProxyHints(draft.hints), host: draft.host.trim(), name: draft.name.trim(), port: portOf(draft), protocol: draft.protocol,
    ...(country ? { country } : {}), ...(draft.login ? { login: draft.login } : {}), ...(draft.password ? { password: draft.password } : {}) };
}

/**
 * Only what changed. An empty password stays absent, which keeps the stored
 * one; the explicit removal sends null. Null without changes.
 */
export function proxyUpdateInput(draft: ProxyDraft, original: ProxyWire): ProxyUpdateInput | null {
  const hints = parseProxyHints(draft.hints);
  const changes: Omit<ProxyUpdateInput, "expectedVersion"> = {
    ...(countryOf(draft) !== original.country ? { country: countryOf(draft) } : {}),
    ...(hints.join("\n") !== original.domainHints.join("\n") ? { domainHints: hints } : {}),
    ...(draft.host.trim() !== original.host ? { host: draft.host.trim() } : {}),
    ...((draft.login || null) !== original.login ? { login: draft.login || null } : {}),
    ...(draft.name.trim() !== original.name ? { name: draft.name.trim() } : {}),
    ...(portOf(draft) !== original.port ? { port: portOf(draft) } : {}),
    ...(draft.protocol !== original.protocol ? { protocol: draft.protocol } : {}),
    ...(draft.removePassword ? { password: null } : draft.password ? { password: draft.password } : {})
  };
  return Object.keys(changes).length === 0 ? null : { ...changes, expectedVersion: original.version };
}

/** After a conflict: what the person typed stays, and everything else shows the latest version. */
export function rebaseProxyDraft(draft: ProxyDraft, initial: ProxyDraft, latest: ProxyWire): ProxyDraft {
  const next = proxyDraftFrom(latest);
  const keep = <Key extends keyof ProxyDraft>(key: Key) => draft[key] === initial[key] ? next[key] : draft[key];
  return { country: keep("country"), hints: keep("hints"), host: keep("host"), login: keep("login"), name: keep("name"), password: draft.password,
    port: keep("port"), protocol: keep("protocol"), removePassword: draft.removePassword && latest.hasPassword };
}
