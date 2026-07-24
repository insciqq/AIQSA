import { lookup as dnsLookup } from "node:dns/promises";
import { connect as netConnect, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";
import { networkAddressScope } from "../mcp/safeFetch";
import {
  normalizeSmtpCompleteConfiguration,
  normalizeSmtpProductMessage,
  SmtpDefinitionError,
  type SmtpCompleteConfiguration,
  type SmtpMailbox,
  type SmtpProductMessage
} from "./definitions";

const DEFAULT_LIMITS: SmtpTransportLimits = {
  commandTimeoutMs: 15_000,
  connectTimeoutMs: 10_000,
  maxCommands: 16,
  maxMessageBytes: 384 * 1_024,
  maxReplyBytes: 64 * 1_024,
  maxReplyLineBytes: 2 * 1_024,
  maxReplyLines: 128,
  totalTimeoutMs: 60_000
};

const HARD_LIMITS: SmtpTransportLimits = {
  commandTimeoutMs: 60_000,
  connectTimeoutMs: 60_000,
  maxCommands: 32,
  maxMessageBytes: 512 * 1_024,
  maxReplyBytes: 256 * 1_024,
  maxReplyLineBytes: 8 * 1_024,
  maxReplyLines: 256,
  totalTimeoutMs: 600_000
};

const MAX_COMMAND_BYTES = 8 * 1_024;
const MAX_DNS_ADDRESSES = 32;
const EHLO_NAME = "aiqsa.local";

export type SmtpResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export type SmtpTlsConnectionInput = SmtpResolvedAddress & {
  hostname: string;
  port: number;
  rejectUnauthorized: true;
  servername: string | null;
  verificationHost: string;
};

export type SmtpStartTlsInput = {
  hostname: string;
  rejectUnauthorized: true;
  servername: string | null;
  socket: Duplex;
  verificationHost: string;
};

export type SmtpConnector = {
  connectPlain(input: SmtpResolvedAddress & { hostname: string; port: number }): Duplex;
  connectTls(input: SmtpTlsConnectionInput): Duplex;
  startTls(input: SmtpStartTlsInput): Duplex;
};

export type SmtpTransportLimits = {
  commandTimeoutMs: number;
  connectTimeoutMs: number;
  maxCommands: number;
  maxMessageBytes: number;
  maxReplyBytes: number;
  maxReplyLineBytes: number;
  maxReplyLines: number;
  totalTimeoutMs: number;
};

export type SmtpFailureCode =
  | "smtp_address_forbidden"
  | "smtp_authentication_failed"
  | "smtp_authentication_unavailable"
  | "smtp_command_timeout"
  | "smtp_connect_timeout"
  | "smtp_connection_failed"
  | "smtp_data_rejected"
  | "smtp_dns_failed"
  | "smtp_ehlo_failed"
  | "smtp_greeting_rejected"
  | "smtp_invalid_input"
  | "smtp_protocol_error"
  | "smtp_recipient_rejected"
  | "smtp_reply_limit"
  | "smtp_sender_rejected"
  | "smtp_starttls_failed"
  | "smtp_starttls_unavailable"
  | "smtp_tls_failed"
  | "smtp_total_timeout";

export type SmtpSendOutcome =
  | { kind: "accepted" }
  | { code: SmtpFailureCode; kind: "failed" }
  | { kind: "ambiguous_after_data" };

export type SmtpTransport = {
  send(input: {
    configuration: SmtpCompleteConfiguration;
    message: SmtpProductMessage;
  }): Promise<SmtpSendOutcome>;
};

export type SmtpTransportDependencies = {
  connector?: SmtpConnector;
  limits?: Partial<SmtpTransportLimits>;
  resolveHostname?: (hostname: string) => Promise<readonly SmtpResolvedAddress[]>;
};

class SmtpTransportError extends Error {
  readonly code: SmtpFailureCode;

  constructor(code: SmtpFailureCode) {
    super(code);
    this.code = code;
    this.name = "SmtpTransportError";
  }
}

type SmtpResponse = {
  code: number;
  lines: string[];
};

type ResponseWaiter = {
  expectedCodes: readonly number[];
  rejectCode: SmtpFailureCode;
  reject(error: SmtpTransportError): void;
  resolve(response: SmtpResponse): void;
  timer: ReturnType<typeof setTimeout>;
};

class SmtpDeadline {
  private readonly expiresAt: number;

  constructor(totalTimeoutMs: number) {
    this.expiresAt = Date.now() + totalTimeoutMs;
  }

  phase(maximumMs: number, phaseCode: SmtpFailureCode): { code: SmtpFailureCode; ms: number } {
    const remainingMs = this.expiresAt - Date.now();
    if (remainingMs <= 0) {
      throw new SmtpTransportError("smtp_total_timeout");
    }
    return remainingMs <= maximumMs
      ? { code: "smtp_total_timeout", ms: remainingMs }
      : { code: phaseCode, ms: maximumMs };
  }
}

class SmtpSession {
  private buffer = Buffer.alloc(0);
  private commandCount = 0;
  private currentCode: number | null = null;
  private currentLines: string[] = [];
  private failure: SmtpTransportError | null = null;
  private readonly queuedResponses: SmtpResponse[] = [];
  private replyBytes = 0;
  private replyLines = 0;
  private waiter: ResponseWaiter | null = null;

  private readonly onClose = () => {
    this.abort(new SmtpTransportError("smtp_connection_failed"), false);
    this.detach();
  };

  private readonly onData = (chunk: Buffer | string | Uint8Array) => {
    if (this.failure) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.replyBytes + this.buffer.length + incoming.length > this.limits.maxReplyBytes) {
      this.abort(new SmtpTransportError("smtp_reply_limit"));
      return;
    }
    this.buffer = Buffer.concat([this.buffer, incoming]);
    this.parseBuffer();
  };

  private readonly onError = () => {
    this.abort(new SmtpTransportError("smtp_connection_failed"), false);
  };

  constructor(
    readonly socket: Duplex,
    private readonly deadline: SmtpDeadline,
    private readonly limits: SmtpTransportLimits
  ) {
    socket.on("close", this.onClose);
    socket.on("data", this.onData);
    socket.on("error", this.onError);
  }

  private parseBuffer(): void {
    while (!this.failure) {
      const lineEnd = this.buffer.indexOf("\r\n");
      const bareLf = this.buffer.indexOf("\n");
      if (bareLf >= 0 && (bareLf === 0 || this.buffer[bareLf - 1] !== 0x0d)) {
        this.abort(new SmtpTransportError("smtp_protocol_error"));
        return;
      }
      if (lineEnd < 0) {
        if (this.buffer.length > this.limits.maxReplyLineBytes) {
          this.abort(new SmtpTransportError("smtp_reply_limit"));
        }
        return;
      }
      if (lineEnd > this.limits.maxReplyLineBytes) {
        this.abort(new SmtpTransportError("smtp_reply_limit"));
        return;
      }

      const lineBuffer = this.buffer.subarray(0, lineEnd);
      this.buffer = this.buffer.subarray(lineEnd + 2);
      this.replyBytes += lineEnd + 2;
      this.replyLines += 1;
      if (this.replyLines > this.limits.maxReplyLines) {
        this.abort(new SmtpTransportError("smtp_reply_limit"));
        return;
      }

      const line = lineBuffer.toString("utf8");
      const match = /^(\d{3})([- ])(.*)$/u.exec(line);
      if (!match) {
        this.abort(new SmtpTransportError("smtp_protocol_error"));
        return;
      }
      const code = Number(match[1]);
      const separator = match[2];
      const text = match[3] ?? "";
      if (!Number.isInteger(code) || code < 100 || code > 599) {
        this.abort(new SmtpTransportError("smtp_protocol_error"));
        return;
      }
      if (this.currentCode === null) {
        this.currentCode = code;
      } else if (this.currentCode !== code) {
        this.abort(new SmtpTransportError("smtp_protocol_error"));
        return;
      }
      this.currentLines.push(text);
      if (separator === " ") {
        const response = { code, lines: this.currentLines };
        this.currentCode = null;
        this.currentLines = [];
        this.deliver(response);
      }
    }
  }

  private deliver(response: SmtpResponse): void {
    const waiter = this.waiter;
    if (!waiter) {
      if (this.queuedResponses.length >= this.limits.maxCommands + 1) {
        this.abort(new SmtpTransportError("smtp_protocol_error"));
        return;
      }
      this.queuedResponses.push(response);
      return;
    }

    this.waiter = null;
    clearTimeout(waiter.timer);
    if (waiter.expectedCodes.includes(response.code)) {
      waiter.resolve(response);
    } else {
      waiter.reject(new SmtpTransportError(waiter.rejectCode));
    }
  }

  private abort(error: SmtpTransportError, destroy = true): void {
    if (this.failure) return;
    this.failure = error;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    if (destroy && !this.socket.destroyed) {
      this.socket.destroy();
    }
  }

  private settleQueued(
    response: SmtpResponse,
    expectedCodes: readonly number[],
    rejectCode: SmtpFailureCode
  ): Promise<SmtpResponse> {
    return expectedCodes.includes(response.code)
      ? Promise.resolve(response)
      : Promise.reject(new SmtpTransportError(rejectCode));
  }

  readResponse(
    expectedCodes: readonly number[],
    rejectCode: SmtpFailureCode,
    timeoutMs = this.limits.commandTimeoutMs,
    timeoutCode: SmtpFailureCode = "smtp_command_timeout"
  ): Promise<SmtpResponse> {
    if (this.failure) return Promise.reject(this.failure);
    const queued = this.queuedResponses.shift();
    if (queued) return this.settleQueued(queued, expectedCodes, rejectCode);
    if (this.waiter) return Promise.reject(new SmtpTransportError("smtp_protocol_error"));

    let timeout: { code: SmtpFailureCode; ms: number };
    try {
      timeout = this.deadline.phase(timeoutMs, timeoutCode);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<SmtpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.abort(new SmtpTransportError(timeout.code));
      }, timeout.ms);
      this.waiter = {
        expectedCodes,
        rejectCode,
        reject,
        resolve,
        timer
      };
    });
  }

  writeCommand(command: string): void {
    if (
      this.failure ||
      /[\r\n]/u.test(command) ||
      Buffer.byteLength(command, "utf8") + 2 > MAX_COMMAND_BYTES ||
      ++this.commandCount > this.limits.maxCommands
    ) {
      throw this.failure ?? new SmtpTransportError("smtp_protocol_error");
    }
    this.writeRaw(`${command}\r\n`);
  }

  writeData(data: string): void {
    if (Buffer.byteLength(data, "utf8") > this.limits.maxMessageBytes) {
      throw new SmtpTransportError("smtp_invalid_input");
    }
    this.writeRaw(data);
  }

  private writeRaw(data: string): void {
    if (this.failure || this.socket.destroyed || !this.socket.writable) {
      throw this.failure ?? new SmtpTransportError("smtp_connection_failed");
    }
    try {
      this.socket.write(data);
    } catch {
      throw new SmtpTransportError("smtp_connection_failed");
    }
  }

  detach(): void {
    this.socket.off("close", this.onClose);
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
  }

  destroy(): void {
    if (!this.socket.destroyed) this.socket.destroy();
  }

  end(): void {
    this.socket.off("data", this.onData);
    try {
      this.socket.end();
    } catch {
      this.socket.destroy();
    }
  }
}

function normalizeLimits(overrides: Partial<SmtpTransportLimits> | undefined): SmtpTransportLimits {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof SmtpTransportLimits>) {
    const value = overrides?.[key];
    if (typeof value !== "undefined") {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("smtp_transport_limits_invalid");
      }
      limits[key] = Math.min(value, HARD_LIMITS[key]);
    }
  }
  return limits;
}

async function defaultResolveHostname(hostname: string): Promise<readonly SmtpResolvedAddress[]> {
  const family = isIP(hostname);
  if (family === 4 || family === 6) {
    return [{ address: hostname, family }];
  }
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({
    address: record.address,
    family: record.family === 6 ? 6 : 4
  }));
}

function tlsIdentity(hostname: string): Pick<
  SmtpTlsConnectionInput,
  "rejectUnauthorized" | "servername" | "verificationHost"
> {
  return {
    rejectUnauthorized: true,
    servername: isIP(hostname) ? null : hostname,
    verificationHost: hostname
  };
}

export const defaultSmtpConnector: SmtpConnector = {
  connectPlain(input) {
    return netConnect({
      family: input.family,
      host: input.address,
      port: input.port
    });
  },
  connectTls(input) {
    return tlsConnect({
      checkServerIdentity: (_hostname, certificate) =>
        checkServerIdentity(input.verificationHost, certificate),
      host: input.address,
      port: input.port,
      rejectUnauthorized: true,
      ...(input.servername ? { servername: input.servername } : {})
    });
  },
  startTls(input) {
    return tlsConnect({
      checkServerIdentity: (_hostname, certificate) =>
        checkServerIdentity(input.verificationHost, certificate),
      rejectUnauthorized: true,
      ...(input.servername ? { servername: input.servername } : {}),
      socket: input.socket
    });
  }
};

function asTransportError(error: unknown): SmtpTransportError {
  if (error instanceof SmtpTransportError) return error;
  if (error instanceof SmtpDefinitionError) return new SmtpTransportError("smtp_invalid_input");
  return new SmtpTransportError("smtp_connection_failed");
}

async function withDeadline<T>(
  operation: Promise<T>,
  deadline: SmtpDeadline,
  maximumMs: number,
  timeoutCode: SmtpFailureCode
): Promise<T> {
  const timeout = deadline.phase(maximumMs, timeoutCode);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SmtpTransportError(timeout.code)), timeout.ms);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function resolvePinnedAddress(input: {
  configuration: SmtpCompleteConfiguration;
  deadline: SmtpDeadline;
  limits: SmtpTransportLimits;
  resolveHostname: (hostname: string) => Promise<readonly SmtpResolvedAddress[]>;
}): Promise<SmtpResolvedAddress> {
  let records: readonly SmtpResolvedAddress[];
  try {
    records = await withDeadline(
      Promise.resolve(input.resolveHostname(input.configuration.host)),
      input.deadline,
      input.limits.connectTimeoutMs,
      "smtp_connect_timeout"
    );
  } catch (error) {
    if (error instanceof SmtpTransportError) throw error;
    throw new SmtpTransportError("smtp_dns_failed");
  }
  if (
    !Array.isArray(records) ||
    records.length === 0 ||
    records.length > MAX_DNS_ADDRESSES ||
    records.some((record) =>
      !record ||
      typeof record.address !== "string" ||
      (record.family !== 4 && record.family !== 6) ||
      isIP(record.address) !== record.family
    )
  ) {
    throw new SmtpTransportError("smtp_dns_failed");
  }

  const scopes = records.map((record) => networkAddressScope(record.address));
  const allowed = input.configuration.transport === "plaintext_internal_no_auth"
    ? scopes.every((scope) => scope === "private" || scope === "loopback")
    : input.configuration.allowInternalNetwork
      ? scopes.every((scope) => scope !== "forbidden")
      : scopes.every((scope) => scope === "public");
  if (!allowed) {
    throw new SmtpTransportError("smtp_address_forbidden");
  }
  return records[0] as SmtpResolvedAddress;
}

function waitForSocketReady(input: {
  deadline: SmtpDeadline;
  failureCode: SmtpFailureCode;
  limits: SmtpTransportLimits;
  readyEvent: "connect" | "secureConnect";
  socket: Duplex;
}): Promise<void> {
  const timeout = input.deadline.phase(input.limits.connectTimeoutMs, "smtp_connect_timeout");
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      input.socket.off("close", onClose);
      input.socket.off("error", onError);
      input.socket.off(input.readyEvent, onReady);
    };
    const finish = (error?: SmtpTransportError) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => finish(new SmtpTransportError(input.failureCode));
    const onError = () => finish(new SmtpTransportError(input.failureCode));
    const onReady = () => finish();
    const timer = setTimeout(() => {
      finish(new SmtpTransportError(timeout.code));
      input.socket.destroy();
    }, timeout.ms);
    input.socket.once("close", onClose);
    input.socket.once("error", onError);
    input.socket.once(input.readyEvent, onReady);
  });
}

function formatMailbox(mailbox: SmtpMailbox): string {
  if (!mailbox.displayName) return mailbox.address;
  const displayName = mailbox.displayName.replace(/(["\\])/gu, "\\$1");
  return `"${displayName}" <${mailbox.address}>`;
}

function wrapBase64(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return encoded.match(/.{1,76}/gu)?.join("\r\n") ?? "";
}

function messageData(configuration: SmtpCompleteConfiguration, message: SmtpProductMessage): string {
  return [
    `From: ${formatMailbox(configuration.from)}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `X-AIQSA-Message-Type: ${message.kind}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(message.text),
    ".",
    ""
  ].join("\r\n");
}

function advertisesStartTls(response: SmtpResponse): boolean {
  return response.lines.some((line) => /(?:^|\s)STARTTLS(?:\s|$)/iu.test(line));
}

function advertisesAuthPlain(response: SmtpResponse): boolean {
  return response.lines.some((line) => {
    const match = /^AUTH(?:=|\s+)(.*)$/iu.exec(line.trim());
    return match?.[1]?.split(/\s+/u).some((mechanism) => mechanism.toUpperCase() === "PLAIN") ?? false;
  });
}

async function ehlo(session: SmtpSession, limits: SmtpTransportLimits): Promise<SmtpResponse> {
  session.writeCommand(`EHLO ${EHLO_NAME}`);
  return session.readResponse([250], "smtp_ehlo_failed", limits.commandTimeoutMs);
}

export function createSmtpTransport(
  dependencies: SmtpTransportDependencies = {}
): SmtpTransport {
  const connector = dependencies.connector ?? defaultSmtpConnector;
  const limits = normalizeLimits(dependencies.limits);
  const resolveHostname = dependencies.resolveHostname ?? defaultResolveHostname;

  return {
    async send(input): Promise<SmtpSendOutcome> {
      let configuration: SmtpCompleteConfiguration;
      let message: SmtpProductMessage;
      try {
        configuration = normalizeSmtpCompleteConfiguration(input.configuration);
        message = normalizeSmtpProductMessage(input.message);
      } catch {
        return { code: "smtp_invalid_input", kind: "failed" };
      }
      const data = messageData(configuration, message);
      if (Buffer.byteLength(data, "utf8") > limits.maxMessageBytes) {
        return { code: "smtp_invalid_input", kind: "failed" };
      }

      const deadline = new SmtpDeadline(limits.totalTimeoutMs);
      let dataSubmitted = false;
      let session: SmtpSession | null = null;

      try {
        const address = await resolvePinnedAddress({
          configuration,
          deadline,
          limits,
          resolveHostname
        });
        const identity = tlsIdentity(configuration.host);
        let socket: Duplex;
        let verifiedTls = false;

        if (configuration.transport === "implicit_tls") {
          try {
            socket = connector.connectTls({
              ...address,
              ...identity,
              hostname: configuration.host,
              port: configuration.port
            });
          } catch {
            throw new SmtpTransportError("smtp_tls_failed");
          }
          session = new SmtpSession(socket, deadline, limits);
          await waitForSocketReady({
            deadline,
            failureCode: "smtp_tls_failed",
            limits,
            readyEvent: "secureConnect",
            socket
          });
          verifiedTls = true;
        } else {
          try {
            socket = connector.connectPlain({
              ...address,
              hostname: configuration.host,
              port: configuration.port
            });
          } catch {
            throw new SmtpTransportError("smtp_connection_failed");
          }
          session = new SmtpSession(socket, deadline, limits);
          await waitForSocketReady({
            deadline,
            failureCode: "smtp_connection_failed",
            limits,
            readyEvent: "connect",
            socket
          });
        }

        await session.readResponse(
          [220],
          "smtp_greeting_rejected",
          limits.connectTimeoutMs,
          "smtp_connect_timeout"
        );
        let capabilities = await ehlo(session, limits);

        if (configuration.transport === "starttls_required") {
          if (!advertisesStartTls(capabilities)) {
            throw new SmtpTransportError("smtp_starttls_unavailable");
          }
          session.writeCommand("STARTTLS");
          await session.readResponse([220], "smtp_starttls_failed", limits.commandTimeoutMs);

          const plainSession = session;
          plainSession.detach();
          try {
            socket = connector.startTls({
              ...identity,
              hostname: configuration.host,
              socket
            });
          } catch {
            plainSession.destroy();
            throw new SmtpTransportError("smtp_tls_failed");
          }
          session = new SmtpSession(socket, deadline, limits);
          await waitForSocketReady({
            deadline,
            failureCode: "smtp_tls_failed",
            limits,
            readyEvent: "secureConnect",
            socket
          });
          verifiedTls = true;
          capabilities = await ehlo(session, limits);
        }

        if (configuration.authentication.mode === "password") {
          if (!verifiedTls) {
            throw new SmtpTransportError("smtp_authentication_unavailable");
          }
          if (!advertisesAuthPlain(capabilities)) {
            throw new SmtpTransportError("smtp_authentication_unavailable");
          }
          const auth = Buffer.from(
            `\u0000${configuration.authentication.username}\u0000${configuration.authentication.password}`,
            "utf8"
          ).toString("base64");
          session.writeCommand(`AUTH PLAIN ${auth}`);
          await session.readResponse([235], "smtp_authentication_failed", limits.commandTimeoutMs);
        }

        session.writeCommand(`MAIL FROM:<${configuration.from.address}>`);
        await session.readResponse([250], "smtp_sender_rejected", limits.commandTimeoutMs);
        session.writeCommand(`RCPT TO:<${message.to}>`);
        await session.readResponse([250, 251], "smtp_recipient_rejected", limits.commandTimeoutMs);
        session.writeCommand("DATA");
        await session.readResponse([354], "smtp_data_rejected", limits.commandTimeoutMs);

        dataSubmitted = true;
        session.writeData(data);
        await session.readResponse([250], "smtp_data_rejected", limits.commandTimeoutMs);

        try {
          session.writeCommand("QUIT");
          await session.readResponse([221], "smtp_protocol_error", limits.commandTimeoutMs);
          session.end();
        } catch {
          session.destroy();
        }
        return { kind: "accepted" };
      } catch (error) {
        session?.destroy();
        const failure = asTransportError(error);
        if (dataSubmitted && failure.code !== "smtp_data_rejected") {
          return { kind: "ambiguous_after_data" };
        }
        return { code: failure.code, kind: "failed" };
      }
    }
  };
}
