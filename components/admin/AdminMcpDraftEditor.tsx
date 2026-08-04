"use client";

import {
  type AdminMcpSharedValueDraft,
  changeMcpSourceKind,
  changeMcpRemoteSource,
  joinMcpArguments,
  preparedMcpOAuthPolicy,
  splitMcpArguments,
  splitMcpList
} from "@/components/admin/adminMcpDraft";
import {
  focusRing,
  inputClass,
  quietButton,
  touchTarget
} from "@/components/admin/adminPrimitives";
import type {
  AdminMcpServer,
  McpConfigurationSlot,
  McpDraftConfiguration,
  McpSlotPolicy,
  McpSlotValue,
  McpSource
} from "@/lib/contracts/mcp";
import { Plus, Trash2 } from "lucide-react";

type AdminMcpDraftEditorProps = Readonly<{
  disabled: boolean;
  draft: McpDraftConfiguration;
  onChange(draft: McpDraftConfiguration): void;
  onSharedValueChange(slotKey: string, value: McpSlotValue | null | undefined): void;
  sharedValueDraft: AdminMcpSharedValueDraft;
  storedSharedValues?: AdminMcpServer["sharedValues"];
}>;

const fieldLabel = "text-xs font-medium text-ink-secondary";
const helpText = "mt-1 text-metadata text-ink-muted";
const checkboxClass = "size-4 shrink-0 accent-proof";

function nextSlotKey(slots: readonly McpConfigurationSlot[]): string {
  const existing = new Set(slots.map((slot) => slot.slotKey));
  let index = slots.length + 1;
  while (existing.has(`value_${index}`)) index += 1;
  return `value_${index}`;
}

function defaultSlot(draft: McpDraftConfiguration): McpConfigurationSlot {
  const slotKey = nextSlotKey(draft.slots);
  return {
    label: "New value",
    policy: { allowPersonalOverride: false, kind: "shared" },
    sensitive: true,
    slotKey,
    target: {
      kind: draft.source.kind === "remote" ? "header" : "environment",
      name: draft.source.kind === "remote" ? "Authorization" : "API_KEY"
    },
    valueType: "secret"
  };
}

function defaultLiteral(type: McpConfigurationSlot["valueType"], enumValues?: readonly string[]): McpSlotValue {
  if (type === "boolean") return false;
  if (type === "number") return 0;
  if (type === "enum") return enumValues?.[0] ?? "value";
  return "";
}

function changePolicy(slot: McpConfigurationSlot, kind: McpSlotPolicy["kind"]): McpConfigurationSlot {
  if (kind === "literal") {
    return {
      ...slot,
      policy: { kind, value: defaultLiteral(slot.valueType, slot.enumValues) },
      sensitive: false
    };
  }
  if (kind === "personal") return { ...slot, policy: { kind, required: true } };
  return { ...slot, policy: { allowPersonalOverride: false, kind } };
}

function changeValueType(
  slot: McpConfigurationSlot,
  valueType: McpConfigurationSlot["valueType"]
): McpConfigurationSlot {
  const enumValues = valueType === "enum" ? slot.enumValues?.length ? slot.enumValues : ["value"] : undefined;
  const policy = slot.policy.kind === "literal"
    ? { kind: "literal" as const, value: defaultLiteral(valueType, enumValues) }
    : slot.policy;
  return {
    ...slot,
    policy,
    sensitive: valueType === "secret" ? true : slot.sensitive,
    valueType,
    ...(enumValues ? { enumValues } : {})
  };
}

function valueFromInput(slot: McpConfigurationSlot, raw: string): McpSlotValue {
  if (slot.valueType === "number") return Number(raw);
  if (slot.valueType === "boolean") return raw === "true";
  return raw;
}

function SourceEditor({
  disabled,
  draft,
  onChange
}: Pick<AdminMcpDraftEditorProps, "disabled" | "draft" | "onChange">) {
  const source = draft.source;
  const setSource = (next: McpSource) => onChange(
    next.kind === "remote" ? changeMcpRemoteSource(draft, next) : { ...draft, source: next }
  );

  return (
    <section className="grid min-w-0 gap-3 rounded-panel bg-workspace-rail/45 p-3">
      <div>
        <h4 className="text-xs font-semibold text-ink">Source and transport</h4>
        <p className={helpText}>Package selectors are resolved to an immutable revision when the draft is tested.</p>
      </div>
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <label className="min-w-0">
          <span className={fieldLabel}>Source</span>
          <select
            className={inputClass}
            disabled={disabled}
            onChange={(event) => onChange(changeMcpSourceKind(draft, event.currentTarget.value as McpSource["kind"]))}
            value={source.kind}
          >
            <option value="remote">Remote URL</option>
            <option value="npm">npm / npx package</option>
            <option value="pypi">PyPI / uvx package</option>
            <option value="oci">OCI image</option>
          </select>
        </label>
        <label className="min-w-0">
          <span className={fieldLabel}>Transport</span>
          <select
            className={inputClass}
            disabled={disabled}
            onChange={(event) => onChange({
              ...draft,
              transport: event.currentTarget.value as McpDraftConfiguration["transport"]
            })}
            value={draft.transport}
          >
            <option disabled={source.kind !== "remote"} value="streamable_http">Streamable HTTP</option>
            <option disabled={source.kind === "remote"} value="stdio">stdio</option>
          </select>
        </label>
      </div>

      {source.kind === "remote" ? (
        <>
          <label>
            <span className={fieldLabel}>MCP endpoint URL</span>
            <input
              className={inputClass}
              disabled={disabled}
              onChange={(event) => setSource({ ...source, url: event.currentTarget.value })}
              placeholder="https://mcp.example.com/mcp"
              type="url"
              value={source.url}
            />
            <span className={helpText}>Stored as non-secret admin configuration. Do not put credentials in the path; query strings are rejected. Use a static header field or OAuth.</span>
          </label>
          <label className={`flex min-h-control items-center gap-2 text-xs text-ink-secondary ${touchTarget}`}>
            <input
              checked={source.allowPrivateNetwork === true}
              className={checkboxClass}
              disabled={disabled}
              onChange={(event) => setSource({
                ...source,
                ...(event.currentTarget.checked ? { allowPrivateNetwork: true } : { allowPrivateNetwork: undefined })
              })}
              type="checkbox"
            />
            Allow this endpoint to resolve to the installation&apos;s private network
          </label>
          {source.allowPrivateNetwork ? (
            <p className="rounded-control bg-caution/10 px-3 py-2 text-xs leading-5 text-caution">
              Private-network access weakens the default SSRF boundary. Use it only for an endpoint you operate.
            </p>
          ) : null}
        </>
      ) : source.kind === "npm" || source.kind === "pypi" ? (
        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          <label>
            <span className={fieldLabel}>{source.kind === "npm" ? "npm package" : "PyPI package"}</span>
            <input
              className={inputClass}
              disabled={disabled}
              onChange={(event) => setSource({ ...source, packageName: event.currentTarget.value })}
              placeholder={source.kind === "npm" ? "@scope/mcp-server" : "mcp-server"}
              value={source.packageName}
            />
          </label>
          <label>
            <span className={fieldLabel}>Requested version selector</span>
            <input
              className={inputClass}
              disabled={disabled}
              onChange={(event) => setSource({ ...source, versionSelector: event.currentTarget.value || undefined })}
              placeholder={source.kind === "npm" ? "^2.0.0 or latest" : "==2.0.0"}
              value={source.versionSelector ?? ""}
            />
          </label>
          <label className="md:col-span-2">
            <span className={fieldLabel}>Arguments, one per line</span>
            <textarea
              className={`${inputClass} min-h-24 py-2 font-mono text-xs`}
              disabled={disabled}
              onChange={(event) => setSource({ ...source, args: splitMcpArguments(event.currentTarget.value) })}
              value={joinMcpArguments(source.args)}
            />
          </label>
        </div>
      ) : (
        <div className="grid min-w-0 gap-3">
          <label>
            <span className={fieldLabel}>OCI image digest</span>
            <input
              className={`${inputClass} font-mono text-xs`}
              disabled={disabled}
              onChange={(event) => setSource({ ...source, image: event.currentTarget.value })}
              placeholder="ghcr.io/team/server@sha256:…"
              value={source.image}
            />
            <p className={helpText}>An immutable sha256 digest is required; mutable image tags are rejected.</p>
          </label>
          <label>
            <span className={fieldLabel}>Arguments, one per line</span>
            <textarea
              className={`${inputClass} min-h-24 py-2 font-mono text-xs`}
              disabled={disabled}
              onChange={(event) => setSource({ ...source, args: splitMcpArguments(event.currentTarget.value) })}
              value={joinMcpArguments(source.args)}
            />
          </label>
        </div>
      )}

      {source.kind !== "remote" ? (
        <p className="rounded-control bg-caution/10 px-3 py-2 text-xs leading-5 text-caution">
          Local MCP code runs in a ToolHive-managed sibling container with unrestricted outbound networking. Its effective environment is visible in Docker metadata to trusted host administrators.
        </p>
      ) : null}
    </section>
  );
}

function AuthEditor({
  disabled,
  draft,
  onChange
}: Pick<AdminMcpDraftEditorProps, "disabled" | "draft" | "onChange">) {
  const setMode = (mode: "none" | "oauth" | "static") => {
    if (mode === "oauth") {
      if (draft.source.kind !== "remote") return;
      onChange({
        ...draft,
        auth: preparedMcpOAuthPolicy(draft.source)
      });
    } else {
      onChange({ ...draft, auth: { mode } });
    }
  };
  const oauth = draft.auth.mode === "oauth" ? draft.auth : null;

  return (
    <section className="grid min-w-0 gap-3 rounded-panel bg-workspace-rail/45 p-3">
      <div>
        <h4 className="text-xs font-semibold text-ink">Authentication</h4>
        <p className={helpText}>Static credentials come from the explicit fields below. OAuth is available only for remote MCP servers.</p>
      </div>
      <label>
        <span className={fieldLabel}>Mode</span>
        <select
          className={inputClass}
          disabled={disabled}
          onChange={(event) => setMode(event.currentTarget.value as "none" | "oauth" | "static")}
          value={draft.auth.mode}
        >
          <option value="none">No authentication</option>
          <option value="static">Static fields</option>
          <option disabled={draft.source.kind !== "remote"} value="oauth">Per-user OAuth</option>
        </select>
      </label>
      {oauth ? (
        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          <label>
            <span className={fieldLabel}>Protected resource override (optional)</span>
            <input
              className={inputClass}
              disabled={disabled}
              onChange={(event) => onChange({
                ...draft,
                auth: { ...oauth, protectedResource: event.currentTarget.value || undefined }
              })}
              placeholder="Auto-discovered from the MCP endpoint"
              type="url"
              value={oauth.protectedResource ?? ""}
            />
            <span className={helpText}>Leave empty to accept only a same-origin resource identifier returned by OAuth discovery. Cross-origin resources require this explicit reviewed override.</span>
          </label>
          <label>
            <span className={fieldLabel}>Client ID metadata document URL</span>
            <input
              className={inputClass}
              disabled={disabled}
              onChange={(event) => onChange({
                ...draft,
                auth: { ...oauth, clientIdMetadataDocumentUrl: event.currentTarget.value || undefined }
              })}
              placeholder="Optional"
              type="url"
              value={oauth.clientIdMetadataDocumentUrl ?? ""}
            />
          </label>
          <label>
            <span className={fieldLabel}>Requested scopes</span>
            <textarea
              className={`${inputClass} min-h-20 py-2`}
              disabled={disabled}
              onChange={(event) => onChange({
                ...draft,
                auth: { ...oauth, scopes: splitMcpList(event.currentTarget.value) }
              })}
              placeholder="read, write"
              value={oauth.scopes.join("\n")}
            />
          </label>
          <label>
            <span className={fieldLabel}>Allowed authorization server origins</span>
            <textarea
              aria-describedby="mcp-oauth-origins-help"
              aria-label="Allowed authorization server origins"
              className={`${inputClass} min-h-20 py-2`}
              disabled={disabled}
              onChange={(event) => onChange({
                ...draft,
                auth: {
                  ...oauth,
                  allowedAuthorizationServerOrigins: splitMcpList(event.currentTarget.value)
                }
              })}
              placeholder="https://auth.example.com"
              value={oauth.allowedAuthorizationServerOrigins.join("\n")}
            />
            <span className={helpText} id="mcp-oauth-origins-help">AIQSA pre-fills the MCP endpoint origin. Add another exact origin only when reviewed OAuth discovery delegates authorization to a different host; do not include a path.</span>
          </label>
        </div>
      ) : null}
    </section>
  );
}

function LiteralValueEditor({
  disabled,
  onChange,
  slot
}: Readonly<{
  disabled: boolean;
  onChange(value: McpSlotValue): void;
  slot: McpConfigurationSlot & { policy: Extract<McpSlotPolicy, { kind: "literal" }> };
}>) {
  if (slot.valueType === "boolean") {
    return (
      <select
        className={inputClass}
        disabled={disabled}
        onChange={(event) => onChange(valueFromInput(slot, event.currentTarget.value))}
        value={String(slot.policy.value)}
      >
        <option value="false">False</option>
        <option value="true">True</option>
      </select>
    );
  }
  if (slot.valueType === "enum") {
    return (
      <select
        className={inputClass}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        value={String(slot.policy.value)}
      >
        {(slot.enumValues ?? []).map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
    );
  }
  return (
    <input
      className={inputClass}
      disabled={disabled}
      onChange={(event) => onChange(valueFromInput(slot, event.currentTarget.value))}
      type={slot.valueType === "number" ? "number" : "text"}
      value={String(slot.policy.value)}
    />
  );
}

function SlotEditor({
  disabled,
  draft,
  index,
  onChange,
  onSharedValueChange,
  sharedValueDraft,
  slot,
  storedSharedValues
}: AdminMcpDraftEditorProps & Readonly<{ index: number; slot: McpConfigurationSlot }>) {
  const updateSlot = (next: McpConfigurationSlot) => onChange({
    ...draft,
    slots: draft.slots.map((candidate, candidateIndex) => candidateIndex === index ? next : candidate)
  });
  const removeSlot = () => onChange({
    ...draft,
    slots: draft.slots.filter((_, candidateIndex) => candidateIndex !== index)
  });
  const sharedDraft = sharedValueDraft[slot.slotKey];
  const configured = storedSharedValues?.[slot.slotKey]?.configured === true;

  return (
    <section className="grid min-w-0 gap-3 rounded-panel border border-trace-subtle bg-answer-paper p-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h5 className="break-words text-xs font-semibold text-ink">{slot.label || `Field ${index + 1}`}</h5>
          <p className={helpText}>Stable slot key: <span className="font-mono">{slot.slotKey || "not set"}</span></p>
        </div>
        <button
          aria-label={`Remove ${slot.label || `field ${index + 1}`}`}
          className={`grid size-9 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-critical ${focusRing} ${touchTarget}`}
          disabled={disabled}
          onClick={removeSlot}
          type="button"
        >
          <Trash2 aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <label>
          <span className={fieldLabel}>Slot key</span>
          <input
            className={`${inputClass} font-mono text-xs`}
            disabled={disabled}
            onChange={(event) => updateSlot({ ...slot, slotKey: event.currentTarget.value })}
            pattern="[a-z][a-z0-9_.-]*"
            value={slot.slotKey}
          />
          <p className={helpText}>Changing the key creates a new credential identity; old grants do not transfer.</p>
        </label>
        <label>
          <span className={fieldLabel}>User-facing label</span>
          <input
            className={inputClass}
            disabled={disabled}
            onChange={(event) => updateSlot({ ...slot, label: event.currentTarget.value })}
            value={slot.label}
          />
        </label>
        <label className="md:col-span-2">
          <span className={fieldLabel}>Description</span>
          <input
            className={inputClass}
            disabled={disabled}
            onChange={(event) => updateSlot({ ...slot, description: event.currentTarget.value || undefined })}
            value={slot.description ?? ""}
          />
        </label>
        <label>
          <span className={fieldLabel}>{slot.target.kind === "header" ? "HTTP header" : "Environment variable"}</span>
          <input
            className={`${inputClass} font-mono text-xs`}
            disabled={disabled}
            onChange={(event) => updateSlot({
              ...slot,
              target: { ...slot.target, name: event.currentTarget.value }
            })}
            value={slot.target.name}
          />
        </label>
        <label>
          <span className={fieldLabel}>Value type</span>
          <select
            className={inputClass}
            disabled={disabled}
            onChange={(event) => updateSlot(changeValueType(
              slot,
              event.currentTarget.value as McpConfigurationSlot["valueType"]
            ))}
            value={slot.valueType}
          >
            <option value="secret">Secret</option>
            <option value="string">String</option>
            <option value="enum">Choice</option>
            <option value="number">Number</option>
            <option value="boolean">Boolean</option>
          </select>
        </label>
        {slot.valueType === "enum" ? (
          <label className="md:col-span-2">
            <span className={fieldLabel}>Allowed values</span>
            <input
              className={inputClass}
              disabled={disabled}
              onChange={(event) => updateSlot({ ...slot, enumValues: splitMcpList(event.currentTarget.value) })}
              placeholder="option-a, option-b"
              value={(slot.enumValues ?? []).join(", ")}
            />
          </label>
        ) : null}
        {slot.valueType === "secret" || slot.valueType === "string" ? (
          <div className="grid grid-cols-2 gap-3 md:col-span-2">
            <label>
              <span className={fieldLabel}>Minimum length</span>
              <input
                className={inputClass}
                disabled={disabled}
                min={0}
                onChange={(event) => updateSlot({
                  ...slot,
                  minLength: event.currentTarget.value ? Number(event.currentTarget.value) : undefined
                })}
                type="number"
                value={slot.minLength ?? ""}
              />
            </label>
            <label>
              <span className={fieldLabel}>Maximum length</span>
              <input
                className={inputClass}
                disabled={disabled}
                min={1}
                onChange={(event) => updateSlot({
                  ...slot,
                  maxLength: event.currentTarget.value ? Number(event.currentTarget.value) : undefined
                })}
                type="number"
                value={slot.maxLength ?? ""}
              />
            </label>
          </div>
        ) : null}
        <label>
          <span className={fieldLabel}>Value ownership</span>
          <select
            className={inputClass}
            disabled={disabled}
            onChange={(event) => updateSlot(changePolicy(slot, event.currentTarget.value as McpSlotPolicy["kind"]))}
            value={slot.policy.kind}
          >
            <option value="shared">Administrator shared value</option>
            <option value="personal">Required personal value</option>
            <option disabled={slot.valueType === "secret"} value="literal">Literal configuration</option>
          </select>
        </label>
        <label className={`flex min-h-control items-center gap-2 self-end text-xs text-ink-secondary ${touchTarget}`}>
          <input
            checked={slot.sensitive}
            className={checkboxClass}
            disabled={disabled || slot.valueType === "secret" || slot.policy.kind === "literal"}
            onChange={(event) => updateSlot({ ...slot, sensitive: event.currentTarget.checked })}
            type="checkbox"
          />
          Sensitive and write-only
        </label>
      </div>

      {slot.policy.kind === "shared" ? (
        <div className="grid min-w-0 gap-2 rounded-control bg-control-surface p-3">
          <label>
            <span className={fieldLabel}>New shared value for {slot.label}</span>
            {slot.valueType === "boolean" ? (
              <select
                className={inputClass}
                disabled={disabled}
                onChange={(event) => onSharedValueChange(
                  slot.slotKey,
                  event.currentTarget.value === "" ? undefined : event.currentTarget.value === "true"
                )}
                value={sharedDraft === null || typeof sharedDraft === "undefined" ? "" : String(sharedDraft)}
              >
                <option value="">{configured ? "Configured — keep current" : "Select a value"}</option>
                <option value="false">False</option>
                <option value="true">True</option>
              </select>
            ) : slot.valueType === "enum" ? (
              <select
                className={inputClass}
                disabled={disabled}
                onChange={(event) => onSharedValueChange(slot.slotKey, event.currentTarget.value || undefined)}
                value={sharedDraft === null || typeof sharedDraft === "undefined" ? "" : String(sharedDraft)}
              >
                <option value="">{configured ? "Configured — keep current" : "Select a value"}</option>
                {(slot.enumValues ?? []).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            ) : (
              <input
                autoComplete="new-password"
                className={inputClass}
                disabled={disabled}
                onChange={(event) => onSharedValueChange(
                  slot.slotKey,
                  event.currentTarget.value === "" ? undefined : valueFromInput(slot, event.currentTarget.value)
                )}
                placeholder={configured ? "Configured — leave blank to keep" : "Enter a value before testing"}
                type={slot.sensitive ? "password" : slot.valueType === "number" ? "number" : "text"}
                value={sharedDraft === null || typeof sharedDraft === "undefined" ? "" : String(sharedDraft)}
              />
            )}
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className={`flex min-h-control-sm items-center gap-2 text-xs text-ink-secondary ${touchTarget}`}>
              <input
                checked={slot.policy.allowPersonalOverride}
                className={checkboxClass}
                disabled={disabled}
                onChange={(event) => updateSlot({
                  ...slot,
                  policy: { allowPersonalOverride: event.currentTarget.checked, kind: "shared" }
                })}
                type="checkbox"
              />
              Permit explicitly granted users to override this value
            </label>
            {configured || sharedDraft !== undefined ? (
              <button
                className={quietButton}
                disabled={disabled}
                onClick={() => onSharedValueChange(slot.slotKey, null)}
                type="button"
              >
                Clear stored value
              </button>
            ) : null}
          </div>
          {sharedDraft === null ? <p className="text-xs text-caution">The stored shared value will be cleared on Save.</p> : null}
          <p className={helpText}>Existing values are never returned to this form. Leaving the field blank keeps the current value.</p>
        </div>
      ) : slot.policy.kind === "literal" ? (
        <label>
          <span className={fieldLabel}>Literal value</span>
          <LiteralValueEditor
            disabled={disabled}
            onChange={(value) => updateSlot({ ...slot, policy: { kind: "literal", value } })}
            slot={slot as McpConfigurationSlot & { policy: Extract<McpSlotPolicy, { kind: "literal" }> }}
          />
        </label>
      ) : (
        <p className="rounded-control bg-caution/10 px-3 py-2 text-xs leading-5 text-caution">
          Every user must receive an explicit personal-slot grant and provide this value before the MCP can become ready.
        </p>
      )}
    </section>
  );
}

export function AdminMcpDraftEditor(props: AdminMcpDraftEditorProps) {
  const { disabled, draft, onChange } = props;
  return (
    <div className="grid min-w-0 gap-3">
      <SourceEditor disabled={disabled} draft={draft} onChange={onChange} />
      <AuthEditor disabled={disabled} draft={draft} onChange={onChange} />
      <section className="grid min-w-0 gap-3 rounded-panel bg-workspace-rail/45 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h4 className="text-xs font-semibold text-ink">Configuration fields</h4>
            <p className={helpText}>Bind only declared values to an HTTP header or process environment variable.</p>
          </div>
          <button
            className={quietButton}
            disabled={disabled}
            onClick={() => onChange({ ...draft, slots: [...draft.slots, defaultSlot(draft)] })}
            type="button"
          >
            <Plus aria-hidden="true" className="size-3.5" />
            Add field
          </button>
        </div>
        {draft.slots.length ? draft.slots.map((slot, index) => (
          <SlotEditor {...props} index={index} key={`${index}:${slot.slotKey}`} slot={slot} />
        )) : (
          <p className="text-xs text-ink-muted">No static or personal configuration fields.</p>
        )}
      </section>
      <section className="grid gap-3 rounded-panel bg-workspace-rail/45 p-3">
        <div>
          <h4 className="text-xs font-semibold text-ink">Runtime timeouts</h4>
          <p className={helpText}>Values are milliseconds, from 1,000 to 600,000.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label>
            <span className={fieldLabel}>Startup timeout</span>
            <input
              className={inputClass}
              disabled={disabled}
              max={600000}
              min={1000}
              onChange={(event) => onChange({
                ...draft,
                runtime: { ...draft.runtime, startupTimeoutMs: Number(event.currentTarget.value) }
              })}
              type="number"
              value={draft.runtime.startupTimeoutMs}
            />
          </label>
          <label>
            <span className={fieldLabel}>Tool call timeout</span>
            <input
              className={inputClass}
              disabled={disabled}
              max={600000}
              min={1000}
              onChange={(event) => onChange({
                ...draft,
                runtime: { ...draft.runtime, callTimeoutMs: Number(event.currentTarget.value) }
              })}
              type="number"
              value={draft.runtime.callTimeoutMs}
            />
          </label>
        </div>
      </section>
    </div>
  );
}
