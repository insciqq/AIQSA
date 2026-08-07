import { createHash } from "node:crypto";
import type {
  McpAuthPolicy,
  McpConfigurationSlot,
  McpDraftConfiguration,
  McpSlotPolicy,
  McpSlotTarget,
  McpSlotValue,
  McpSource,
  McpValidationIssue
} from "@/lib/contracts/mcp";

const MAX_ARGS = 64;
const MAX_ARGUMENT_LENGTH = 2_048;
const MAX_DISABLED_TOOL_NAMES = 512;
const MAX_SLOTS = 64;
const MAX_SLOT_VALUE_LENGTH = 16_384;
const RUNTIME_CONTROL_NAMES = new Set([
  "BASH_ENV",
  "ENV",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "PATH",
  "PERL5OPT",
  "PYTHONHOME",
  "PYTHONPATH",
  "RUBYOPT"
]);
const TOOLHIVE_MANAGED_ENVIRONMENT_NAMES = new Set(["MCP_TRANSPORT"]);

type ObjectValue = Record<string, unknown>;

export type McpDraftValidationResult =
  | { issues: []; ok: true; value: McpDraftConfiguration }
  | { issues: McpValidationIssue[]; ok: false };

function isObject(value: unknown): value is ObjectValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function requiredString(value: unknown, maxLength: number): string | null {
  return optionalString(value, maxLength) ?? null;
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const entries = value.map((entry) => (typeof entry === "string" ? entry : null));
  if (entries.some((entry) => entry === null || entry.length > maxLength || entry.includes("\0"))) return null;
  return entries as string[];
}

function disabledToolNamesFrom(value: unknown, issues: McpValidationIssue[]): string[] | null {
  if (typeof value === "undefined") return [];
  if (!Array.isArray(value) || value.length > MAX_DISABLED_TOOL_NAMES || value.some((name) =>
    typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/u.test(name))) {
    issues.push({ code: "disabled_tool_names_invalid", path: "disabledToolNames" });
    return null;
  }
  return [...new Set(value)].sort();
}

function sourceFrom(value: unknown, issues: McpValidationIssue[]): McpSource | null {
  if (!isObject(value) || typeof value.kind !== "string") {
    issues.push({ code: "source_required", path: "source" });
    return null;
  }

  if (value.kind === "remote") {
    const rawUrl = requiredString(value.url, 2_048);
    const allowPrivateNetwork = value.allowPrivateNetwork;
    if (allowPrivateNetwork !== undefined && typeof allowPrivateNetwork !== "boolean") {
      issues.push({ code: "remote_private_network_policy_invalid", path: "source.allowPrivateNetwork" });
    }
    try {
      const url = new URL(rawUrl ?? "");
      if (!rawUrl || !["http:", "https:"].includes(url.protocol) ||
        url.username || url.password || url.hash || url.search) {
        throw new Error("invalid");
      }
      return {
        kind: "remote",
        url: url.toString(),
        ...(allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {})
      };
    } catch {
      issues.push({ code: "remote_url_invalid", path: "source.url" });
      return null;
    }
  }

  const args = stringArray(value.args ?? [], MAX_ARGS, MAX_ARGUMENT_LENGTH);
  if (!args) issues.push({ code: "source_args_invalid", path: "source.args" });

  if (value.kind === "npm" || value.kind === "pypi") {
    const packageName = requiredString(value.packageName, 256);
    const packagePattern = value.kind === "npm"
      ? /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu
      : /^[a-z0-9][a-z0-9._-]*$/iu;
    if (!packageName || !packagePattern.test(packageName)) {
      issues.push({ code: "package_name_invalid", path: "source.packageName" });
    }
    const versionSelector = optionalString(value.versionSelector, 256);
    if (typeof value.versionSelector !== "undefined" && !versionSelector) {
      issues.push({ code: "version_selector_invalid", path: "source.versionSelector" });
    }
    if (!packageName || !args) return null;
    return {
      args,
      kind: value.kind,
      packageName,
      ...(versionSelector ? { versionSelector } : {})
    };
  }

  if (value.kind === "oci") {
    const image = requiredString(value.image, 512);
    const command = typeof value.command === "undefined"
      ? undefined
      : stringArray(value.command, 32, MAX_ARGUMENT_LENGTH);
    if (!image || /\s/u.test(image)) {
      issues.push({ code: "oci_image_invalid", path: "source.image" });
    } else if (!/^\S+@sha256:[a-f0-9]{64}$/u.test(image)) {
      issues.push({ code: "oci_image_digest_required", path: "source.image" });
    }
    if (command === null) issues.push({ code: "oci_command_invalid", path: "source.command" });
    if (command && command.length > 0) {
      issues.push({ code: "oci_command_override_unsupported", path: "source.command" });
    }
    if (!image || !args || command === null) return null;
    return { args, image, kind: "oci", ...(command ? { command } : {}) };
  }

  issues.push({ code: "source_kind_unsupported", path: "source.kind" });
  return null;
}

function targetFrom(value: unknown, path: string, issues: McpValidationIssue[]): McpSlotTarget | null {
  if (!isObject(value) || (value.kind !== "environment" && value.kind !== "header")) {
    issues.push({ code: "slot_target_invalid", path });
    return null;
  }
  const name = requiredString(value.name, 128);
  const valid = value.kind === "environment"
    ? Boolean(name && /^[A-Z_][A-Z0-9_]*$/u.test(name))
    : Boolean(name && /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(name));
  if (!valid || !name) {
    issues.push({ code: "slot_target_invalid", path });
    return null;
  }
  return { kind: value.kind, name };
}

function primitiveSlotValue(value: unknown): value is McpSlotValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function policyFrom(value: unknown, path: string, issues: McpValidationIssue[]): McpSlotPolicy | null {
  if (!isObject(value) || typeof value.kind !== "string") {
    issues.push({ code: "slot_policy_invalid", path });
    return null;
  }
  if (value.kind === "literal" && primitiveSlotValue(value.value)) {
    return { kind: "literal", value: value.value };
  }
  if (value.kind === "shared" && typeof value.allowPersonalOverride === "boolean") {
    return { allowPersonalOverride: value.allowPersonalOverride, kind: "shared" };
  }
  if (value.kind === "personal" && value.required === true) {
    return { kind: "personal", required: true };
  }
  issues.push({ code: "slot_policy_invalid", path });
  return null;
}

function slotsFrom(value: unknown, source: McpSource | null, issues: McpValidationIssue[]): McpConfigurationSlot[] | null {
  if (!Array.isArray(value) || value.length > MAX_SLOTS) {
    issues.push({ code: "slots_invalid", path: "slots" });
    return null;
  }

  const slots: McpConfigurationSlot[] = [];
  const keys = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const path = `slots.${index}`;
    if (!isObject(candidate)) {
      issues.push({ code: "slot_invalid", path });
      continue;
    }
    const slotKey = requiredString(candidate.slotKey, 128);
    const label = requiredString(candidate.label, 256);
    const description = optionalString(candidate.description, 2_048);
    const target = targetFrom(candidate.target, `${path}.target`, issues);
    const policy = policyFrom(candidate.policy, `${path}.policy`, issues);
    const valueType = candidate.valueType;
    const sensitive = candidate.sensitive;
    if (!slotKey || !/^[a-z][a-z0-9_.-]*$/u.test(slotKey) || keys.has(slotKey)) {
      issues.push({ code: "slot_key_invalid", path: `${path}.slotKey` });
    } else {
      keys.add(slotKey);
    }
    if (!label) issues.push({ code: "slot_label_invalid", path: `${path}.label` });
    if (!["boolean", "enum", "number", "secret", "string"].includes(String(valueType))) {
      issues.push({ code: "slot_value_type_invalid", path: `${path}.valueType` });
    }
    if (typeof sensitive !== "boolean" || (valueType === "secret" && sensitive !== true)) {
      issues.push({ code: "slot_sensitivity_invalid", path: `${path}.sensitive` });
    }
    const enumValues = valueType === "enum" ? stringArray(candidate.enumValues, 64, 256) : undefined;
    if (valueType === "enum" && (!enumValues || enumValues.length === 0 || new Set(enumValues).size !== enumValues.length)) {
      issues.push({ code: "slot_enum_invalid", path: `${path}.enumValues` });
    }
    const minLength = typeof candidate.minLength === "number" && Number.isInteger(candidate.minLength)
      ? candidate.minLength
      : undefined;
    const maxLength = typeof candidate.maxLength === "number" && Number.isInteger(candidate.maxLength)
      ? candidate.maxLength
      : undefined;
    if ((minLength !== undefined && (minLength < 0 || minLength > MAX_SLOT_VALUE_LENGTH)) ||
      (maxLength !== undefined && (maxLength < 1 || maxLength > MAX_SLOT_VALUE_LENGTH)) ||
      (minLength !== undefined && maxLength !== undefined && minLength > maxLength)) {
      issues.push({ code: "slot_bounds_invalid", path });
    }
    if (target && source && ((source.kind === "remote") !== (target.kind === "header"))) {
      issues.push({ code: "slot_target_transport_mismatch", path: `${path}.target` });
    }
    if (target?.kind === "environment" && TOOLHIVE_MANAGED_ENVIRONMENT_NAMES.has(target.name)) {
      issues.push({ code: "slot_toolhive_environment_reserved", path: `${path}.target.name` });
    }
    const personal = policy?.kind === "personal" || (policy?.kind === "shared" && policy.allowPersonalOverride);
    if (personal && target?.kind === "environment" && RUNTIME_CONTROL_NAMES.has(target.name)) {
      issues.push({ code: "slot_runtime_control_forbidden", path: `${path}.target.name` });
    }
    if (policy?.kind === "literal" && sensitive === true) {
      issues.push({ code: "slot_sensitive_literal_forbidden", path: `${path}.policy` });
    }
    if (policy?.kind === "literal" && slotKey && label && target && typeof sensitive === "boolean" &&
      ["boolean", "enum", "number", "secret", "string"].includes(String(valueType))) {
      const literalSlot: McpConfigurationSlot = {
        label,
        policy,
        sensitive,
        slotKey,
        target,
        valueType: valueType as McpConfigurationSlot["valueType"],
        ...(enumValues ? { enumValues } : {}),
        ...(minLength !== undefined ? { minLength } : {}),
        ...(maxLength !== undefined ? { maxLength } : {})
      };
      if (!validateMcpSlotValue(literalSlot, policy.value)) {
        issues.push({ code: "slot_literal_value_invalid", path: `${path}.policy.value` });
      }
    }

    if (slotKey && label && target && policy && typeof sensitive === "boolean" &&
      ["boolean", "enum", "number", "secret", "string"].includes(String(valueType))) {
      slots.push({
        label,
        policy,
        sensitive,
        slotKey,
        target,
        valueType: valueType as McpConfigurationSlot["valueType"],
        ...(description ? { description } : {}),
        ...(enumValues ? { enumValues } : {}),
        ...(minLength !== undefined ? { minLength } : {}),
        ...(maxLength !== undefined ? { maxLength } : {})
      });
    }
  }

  return issues.length === 0 ? slots : null;
}

function authFrom(value: unknown, source: McpSource | null, issues: McpValidationIssue[]): McpAuthPolicy | null {
  if (!isObject(value) || typeof value.mode !== "string") {
    issues.push({ code: "auth_invalid", path: "auth" });
    return null;
  }
  if (value.mode === "none" || value.mode === "static") return { mode: value.mode };
  if (value.mode !== "oauth" || source?.kind !== "remote") {
    issues.push({ code: "auth_mode_invalid", path: "auth.mode" });
    return null;
  }
  const scopes = stringArray(value.scopes, 64, 256);
  const origins = stringArray(value.allowedAuthorizationServerOrigins, 32, 2_048);
  const validOrigins = origins?.every((origin) => {
    try {
      const url = new URL(origin);
      return url.origin === origin && ["http:", "https:"].includes(url.protocol);
    } catch {
      return false;
    }
  });
  const validScopes = scopes?.every((scope) => /^[\x21\x23-\x5B\x5D-\x7E]+$/u.test(scope));
  if (!scopes || !validScopes || !origins || !validOrigins) {
    issues.push({ code: "oauth_policy_invalid", path: "auth" });
    return null;
  }
  const protectedResourceValue = optionalString(value.protectedResource, 2_048);
  const clientIdMetadataDocumentUrlValue = optionalString(value.clientIdMetadataDocumentUrl, 2_048);
  let protectedResource: string | undefined;
  let clientIdMetadataDocumentUrl: string | undefined;
  try {
    if (typeof value.protectedResource !== "undefined") {
      const url = new URL(protectedResourceValue ?? "");
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new Error("invalid");
      }
      protectedResource = url.toString();
    }
    if (typeof value.clientIdMetadataDocumentUrl !== "undefined") {
      const url = new URL(clientIdMetadataDocumentUrlValue ?? "");
      if (url.protocol !== "https:" || url.pathname === "/" || url.username || url.password || url.hash) {
        throw new Error("invalid");
      }
      clientIdMetadataDocumentUrl = url.toString();
    }
  } catch {
    issues.push({ code: "oauth_policy_invalid", path: "auth" });
    return null;
  }
  return {
    allowedAuthorizationServerOrigins: origins,
    mode: "oauth",
    scopes: [...new Set(scopes)],
    ...(protectedResource ? { protectedResource } : {}),
    ...(clientIdMetadataDocumentUrl ? { clientIdMetadataDocumentUrl } : {})
  };
}

function boundedMilliseconds(value: unknown, fallback: number): number | null {
  const candidate = typeof value === "undefined" ? fallback : value;
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 1_000 && candidate <= 600_000
    ? candidate
    : null;
}

export function validateMcpDraft(value: unknown): McpDraftValidationResult {
  const issues: McpValidationIssue[] = [];
  if (!isObject(value)) return { issues: [{ code: "draft_required", path: "draft" }], ok: false };

  const source = sourceFrom(value.source, issues);
  const transport = value.transport;
  if (transport !== "stdio" && transport !== "streamable_http") {
    issues.push({ code: "transport_invalid", path: "transport" });
  } else if (source && ((source.kind === "remote") !== (transport === "streamable_http"))) {
    issues.push({ code: "transport_source_mismatch", path: "transport" });
  }
  const slots = slotsFrom(value.slots, source, issues);
  const auth = authFrom(value.auth, source, issues);
  const disabledToolNames = disabledToolNamesFrom(value.disabledToolNames, issues);
  const runtime = isObject(value.runtime) ? value.runtime : {};
  const startupTimeoutMs = boundedMilliseconds(runtime.startupTimeoutMs, 60_000);
  const callTimeoutMs = boundedMilliseconds(runtime.callTimeoutMs, 60_000);
  if (!startupTimeoutMs) issues.push({ code: "startup_timeout_invalid", path: "runtime.startupTimeoutMs" });
  if (!callTimeoutMs) issues.push({ code: "call_timeout_invalid", path: "runtime.callTimeoutMs" });

  if (issues.length || !source || !slots || !auth || !disabledToolNames || !startupTimeoutMs || !callTimeoutMs ||
    (transport !== "stdio" && transport !== "streamable_http")) {
    return { issues, ok: false };
  }

  return {
    issues: [],
    ok: true,
    value: {
      auth,
      ...(disabledToolNames.length ? { disabledToolNames } : {}),
      runtime: { callTimeoutMs, startupTimeoutMs },
      slots,
      source,
      transport
    }
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function canonicalMcpJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function hashCanonicalMcpValue(value: unknown): string {
  return createHash("sha256").update(canonicalMcpJson(value)).digest("hex");
}

function slotSemanticIdentity(slot: McpConfigurationSlot): unknown {
  const policy = slot.policy.kind === "shared"
    ? { allowPersonalOverride: slot.policy.allowPersonalOverride, kind: slot.policy.kind }
    : slot.policy.kind === "personal"
      ? { kind: slot.policy.kind, required: slot.policy.required }
      : { kind: slot.policy.kind };
  return {
    policy,
    sensitive: slot.sensitive,
    target: slot.target,
    valueType: slot.valueType
  };
}

export function validateMcpSlotIdentityLineage(
  draft: McpDraftConfiguration,
  historical: readonly McpDraftConfiguration[]
): McpValidationIssue[] {
  const identities = new Map<string, string>();
  for (const configuration of historical) {
    for (const slot of configuration.slots) {
      const identity = canonicalMcpJson(slotSemanticIdentity(slot));
      const prior = identities.get(slot.slotKey);
      if (prior !== undefined && prior !== identity) {
        return [{ code: "slot_lineage_invalid", path: `slots.${slot.slotKey}` }];
      }
      identities.set(slot.slotKey, identity);
    }
  }

  return draft.slots.flatMap((slot, index) => {
    const prior = identities.get(slot.slotKey);
    return prior !== undefined && prior !== canonicalMcpJson(slotSemanticIdentity(slot))
      ? [{ code: "slot_key_semantics_changed", path: `slots.${index}.slotKey` }]
      : [];
  });
}

export function validateMcpSlotValue(slot: McpConfigurationSlot, value: unknown): value is McpSlotValue {
  if (slot.valueType === "boolean") return typeof value === "boolean";
  if (slot.valueType === "number") return typeof value === "number" && Number.isFinite(value);
  if (typeof value !== "string" || value.length > (slot.maxLength ?? MAX_SLOT_VALUE_LENGTH) ||
    value.length < (slot.minLength ?? 0)) return false;
  if (slot.valueType === "enum") return Boolean(slot.enumValues?.includes(value));
  return true;
}
