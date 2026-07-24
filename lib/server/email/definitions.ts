import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type {
  AdminEmailConfiguration,
  AdminEmailTransportMode
} from "../../contracts/email";

const MAX_HOST_BYTES = 253;
const MAX_MAILBOX_BYTES = 254;
const MAX_LOCAL_PART_BYTES = 64;
const MAX_DISPLAY_NAME_BYTES = 120;
const MAX_USERNAME_BYTES = 512;
const MAX_PASSWORD_BYTES = 4 * 1_024;
const MAX_SUBJECT_BYTES = 512;
const MAX_MESSAGE_TEXT_BYTES = 256 * 1_024;

const TRANSPORT_MODES = new Set<SmtpTransportMode>([
  "implicit_tls",
  "starttls_required",
  "plaintext_internal_no_auth"
]);
const MESSAGE_KINDS = new Set<SmtpProductMessageKind>([
  "configuration_test",
  "invitation",
  "password_reset",
  "verification"
]);

export type SmtpTransportMode = AdminEmailTransportMode;

export type SmtpMailbox = {
  address: string;
  displayName: string | null;
};

export type SmtpConfiguration = AdminEmailConfiguration;

export type SmtpCompleteConfiguration = Omit<SmtpConfiguration, "authentication"> & {
  authentication:
    | { mode: "none" }
    | { mode: "password"; password: string; username: string };
};

export type SmtpProductMessageKind =
  | "configuration_test"
  | "invitation"
  | "password_reset"
  | "verification";

export type SmtpProductMessage = {
  kind: SmtpProductMessageKind;
  subject: string;
  text: string;
  to: string;
};

export type SmtpDefinitionErrorCode =
  | "smtp_authentication_invalid"
  | "smtp_from_invalid"
  | "smtp_host_invalid"
  | "smtp_internal_approval_required"
  | "smtp_message_invalid"
  | "smtp_password_invalid"
  | "smtp_port_invalid"
  | "smtp_transport_invalid";

export class SmtpDefinitionError extends Error {
  readonly code: SmtpDefinitionErrorCode;

  constructor(code: SmtpDefinitionErrorCode) {
    super(code);
    this.code = code;
    this.name = "SmtpDefinitionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function boundedUtf8(value: string, maxBytes: number): boolean {
  return Buffer.byteLength(value, "utf8") <= maxBytes;
}

function containsHeaderControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function normalizeHostname(value: unknown): string {
  if (typeof value !== "string") {
    throw new SmtpDefinitionError("smtp_host_invalid");
  }

  const candidate = value.trim().replace(/\.$/u, "");
  if (!candidate || containsHeaderControl(candidate)) {
    throw new SmtpDefinitionError("smtp_host_invalid");
  }
  if (isIP(candidate)) {
    return candidate.toLowerCase();
  }
  if (
    /\s/u.test(candidate) ||
    ["/", "@", "[", "]", ":"].some((character) => candidate.includes(character))
  ) {
    throw new SmtpDefinitionError("smtp_host_invalid");
  }

  const hostname = domainToASCII(candidate).toLowerCase();
  const labels = hostname.split(".");
  if (
    !hostname ||
    !boundedUtf8(hostname, MAX_HOST_BYTES) ||
    labels.some((label) =>
      !label ||
      label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    )
  ) {
    throw new SmtpDefinitionError("smtp_host_invalid");
  }

  return hostname;
}

function normalizeMailboxAddress(value: unknown): string {
  if (typeof value !== "string") {
    throw new SmtpDefinitionError("smtp_from_invalid");
  }

  const candidate = value.trim();
  if (!candidate || containsHeaderControl(candidate) || !boundedUtf8(candidate, MAX_MAILBOX_BYTES)) {
    throw new SmtpDefinitionError("smtp_from_invalid");
  }

  const at = candidate.lastIndexOf("@");
  if (at <= 0 || at !== candidate.indexOf("@") || at === candidate.length - 1) {
    throw new SmtpDefinitionError("smtp_from_invalid");
  }

  const localPart = candidate.slice(0, at);
  const rawDomain = candidate.slice(at + 1);
  if (
    !boundedUtf8(localPart, MAX_LOCAL_PART_BYTES) ||
    !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u.test(localPart) ||
    localPart.startsWith(".") ||
    localPart.endsWith(".") ||
    localPart.includes("..") ||
    isIP(rawDomain)
  ) {
    throw new SmtpDefinitionError("smtp_from_invalid");
  }

  let domain: string;
  try {
    domain = normalizeHostname(rawDomain);
  } catch {
    throw new SmtpDefinitionError("smtp_from_invalid");
  }

  const address = `${localPart}@${domain}`;
  if (!boundedUtf8(address, MAX_MAILBOX_BYTES)) {
    throw new SmtpDefinitionError("smtp_from_invalid");
  }
  return address;
}

function normalizeDisplayName(value: unknown): string | null {
  if (value === null || typeof value === "undefined") {
    return null;
  }
  if (typeof value !== "string") {
    throw new SmtpDefinitionError("smtp_from_invalid");
  }
  const candidate = value.trim();
  if (
    !candidate ||
    !boundedUtf8(candidate, MAX_DISPLAY_NAME_BYTES) ||
    containsHeaderControl(candidate) ||
    !/^[\x20-\x7e]+$/u.test(candidate)
  ) {
    throw new SmtpDefinitionError("smtp_from_invalid");
  }
  return candidate;
}

function normalizeFrom(value: unknown): SmtpMailbox {
  if (!isRecord(value) || !Object.keys(value).every((key) => ["address", "displayName"].includes(key))) {
    throw new SmtpDefinitionError("smtp_from_invalid");
  }
  return {
    address: normalizeMailboxAddress(value.address),
    displayName: normalizeDisplayName(value.displayName)
  };
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== "string") {
    throw new SmtpDefinitionError("smtp_authentication_invalid");
  }
  const username = value.trim();
  if (!username || !boundedUtf8(username, MAX_USERNAME_BYTES) || containsHeaderControl(username)) {
    throw new SmtpDefinitionError("smtp_authentication_invalid");
  }
  return username;
}

export function normalizeSmtpPassword(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    !boundedUtf8(value, MAX_PASSWORD_BYTES) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new SmtpDefinitionError("smtp_password_invalid");
  }
  return value;
}

function commonConfiguration(value: unknown): {
  allowInternalNetwork: boolean;
  from: SmtpMailbox;
  host: string;
  port: number;
  transport: SmtpTransportMode;
  authentication: Record<string, unknown>;
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "allowInternalNetwork",
      "authentication",
      "from",
      "host",
      "port",
      "transport"
    ])
  ) {
    throw new SmtpDefinitionError("smtp_transport_invalid");
  }
  if (typeof value.allowInternalNetwork !== "boolean") {
    throw new SmtpDefinitionError("smtp_internal_approval_required");
  }
  if (!TRANSPORT_MODES.has(value.transport as SmtpTransportMode)) {
    throw new SmtpDefinitionError("smtp_transport_invalid");
  }
  if (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65_535) {
    throw new SmtpDefinitionError("smtp_port_invalid");
  }
  if (!isRecord(value.authentication)) {
    throw new SmtpDefinitionError("smtp_authentication_invalid");
  }
  if (value.transport === "plaintext_internal_no_auth" && value.allowInternalNetwork !== true) {
    throw new SmtpDefinitionError("smtp_internal_approval_required");
  }
  if (
    value.transport === "plaintext_internal_no_auth" &&
    value.authentication.mode !== "none"
  ) {
    throw new SmtpDefinitionError("smtp_authentication_invalid");
  }

  return {
    allowInternalNetwork: value.allowInternalNetwork,
    authentication: value.authentication,
    from: normalizeFrom(value.from),
    host: normalizeHostname(value.host),
    port: value.port as number,
    transport: value.transport as SmtpTransportMode
  };
}

export function normalizeSmtpConfiguration(value: unknown): SmtpConfiguration {
  const common = commonConfiguration(value);
  const authentication = common.authentication;

  if (authentication.mode === "none") {
    if (!hasOnlyKeys(authentication, ["mode"])) {
      throw new SmtpDefinitionError("smtp_authentication_invalid");
    }
    return { ...common, authentication: { mode: "none" } };
  }
  if (authentication.mode === "password" && hasOnlyKeys(authentication, ["mode", "username"])) {
    return {
      ...common,
      authentication: {
        mode: "password",
        username: normalizeUsername(authentication.username)
      }
    };
  }
  throw new SmtpDefinitionError("smtp_authentication_invalid");
}

export function normalizeSmtpCompleteConfiguration(value: unknown): SmtpCompleteConfiguration {
  const common = commonConfiguration(value);
  const authentication = common.authentication;

  if (authentication.mode === "none") {
    if (!hasOnlyKeys(authentication, ["mode"])) {
      throw new SmtpDefinitionError("smtp_authentication_invalid");
    }
    return { ...common, authentication: { mode: "none" } };
  }
  if (
    authentication.mode === "password" &&
    hasOnlyKeys(authentication, ["mode", "password", "username"])
  ) {
    return {
      ...common,
      authentication: {
        mode: "password",
        password: normalizeSmtpPassword(authentication.password),
        username: normalizeUsername(authentication.username)
      }
    };
  }
  throw new SmtpDefinitionError("smtp_authentication_invalid");
}

export function completeSmtpConfiguration(input: {
  configuration: unknown;
  password: unknown;
}): SmtpCompleteConfiguration {
  const configuration = normalizeSmtpConfiguration(input.configuration);
  if (configuration.authentication.mode === "none") {
    if (input.password !== null) {
      throw new SmtpDefinitionError("smtp_authentication_invalid");
    }
    return { ...configuration, authentication: { mode: "none" } };
  }

  return normalizeSmtpCompleteConfiguration({
    ...configuration,
    authentication: {
      ...configuration.authentication,
      password: normalizeSmtpPassword(input.password)
    }
  });
}

export function normalizeSmtpProductMessage(value: unknown): SmtpProductMessage {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "subject", "text", "to"])) {
    throw new SmtpDefinitionError("smtp_message_invalid");
  }
  if (!MESSAGE_KINDS.has(value.kind as SmtpProductMessageKind)) {
    throw new SmtpDefinitionError("smtp_message_invalid");
  }
  if (
    typeof value.subject !== "string" ||
    !value.subject.trim() ||
    !boundedUtf8(value.subject, MAX_SUBJECT_BYTES) ||
    containsHeaderControl(value.subject) ||
    !/^[\x20-\x7e]+$/u.test(value.subject)
  ) {
    throw new SmtpDefinitionError("smtp_message_invalid");
  }
  if (
    typeof value.text !== "string" ||
    !boundedUtf8(value.text, MAX_MESSAGE_TEXT_BYTES) ||
    /[\u0000\u007f]/u.test(value.text)
  ) {
    throw new SmtpDefinitionError("smtp_message_invalid");
  }

  let to: string;
  try {
    to = normalizeMailboxAddress(value.to);
  } catch {
    throw new SmtpDefinitionError("smtp_message_invalid");
  }
  return {
    kind: value.kind as SmtpProductMessageKind,
    subject: value.subject.trim(),
    text: value.text.replace(/\r\n?/gu, "\n"),
    to
  };
}
