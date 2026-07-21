import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { createTestAuthMailer } from "./testMailer";
import { isTestAuthEnabled } from "./config";

export type AuthEmail = {
  subject: string;
  text: string;
  to: string;
};

export type AuthMailer = {
  deliveryConfigured: boolean;
  send(email: AuthEmail): Promise<void>;
};

export type SmtpMailConfig = {
  commandTimeoutMs: number;
  configured: boolean;
  connectTimeoutMs: number;
  from: string;
  host: string;
  password: string;
  port: number;
  secure: boolean;
  startTls: boolean;
  totalTimeoutMs: number;
  user: string;
};

export type SmtpConnector = {
  connectPlain(input: { host: string; port: number }): Duplex;
  connectSecure(input: { host: string; port: number }): Duplex;
  startTls(input: { host: string; socket: Duplex }): Duplex;
};

type SmtpResponse = {
  code: number;
  lines: string[];
};

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);
const DEFAULT_SMTP_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_SMTP_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_SMTP_TOTAL_TIMEOUT_MS = 60_000;
const MAX_SMTP_TIMEOUT_MS = 600_000;

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";

  if (TRUE_ENV_VALUES.has(normalized)) {
    return true;
  }

  if (FALSE_ENV_VALUES.has(normalized)) {
    return false;
  }

  return fallback;
}

function envPort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function envTimeout(value: string | undefined, fallback: number): number {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_SMTP_TIMEOUT_MS ? parsed : fallback;
}

export function getSmtpMailConfig(env: Record<string, string | undefined> = process.env): SmtpMailConfig {
  const host = env.AIQSA_SMTP_HOST?.trim() ?? "";
  const secure = envBoolean(env.AIQSA_SMTP_SECURE, false);
  const port = envPort(env.AIQSA_SMTP_PORT, secure ? 465 : 587);
  const from = env.AIQSA_SMTP_FROM?.trim() ?? "";

  return {
    commandTimeoutMs: envTimeout(env.AIQSA_SMTP_COMMAND_TIMEOUT_MS, DEFAULT_SMTP_COMMAND_TIMEOUT_MS),
    configured: Boolean(host && from),
    connectTimeoutMs: envTimeout(env.AIQSA_SMTP_CONNECT_TIMEOUT_MS, DEFAULT_SMTP_CONNECT_TIMEOUT_MS),
    from,
    host,
    password: env.AIQSA_SMTP_PASSWORD ?? "",
    port,
    secure,
    startTls: envBoolean(env.AIQSA_SMTP_STARTTLS, !secure),
    totalTimeoutMs: envTimeout(env.AIQSA_SMTP_TOTAL_TIMEOUT_MS, DEFAULT_SMTP_TOTAL_TIMEOUT_MS),
    user: env.AIQSA_SMTP_USER ?? ""
  };
}

export function createNoopAuthMailer(): AuthMailer {
  return {
    deliveryConfigured: false,
    async send() {
      return undefined;
    }
  };
}

export function createMemoryAuthMailer(): AuthMailer & { sent: AuthEmail[] } {
  const sent: AuthEmail[] = [];

  return {
    deliveryConfigured: true,
    sent,
    async send(email) {
      sent.push(email);
    }
  };
}

function cleanHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function mailAddress(value: string): string {
  const bracketed = /<([^<>]+)>/.exec(value);

  return cleanHeaderValue(bracketed?.[1] ?? value);
}

function dotStuff(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function buildSmtpMessage(input: { email: AuthEmail; from: string }): string {
  const subject = cleanHeaderValue(input.email.subject);
  const to = cleanHeaderValue(input.email.to);
  const from = cleanHeaderValue(input.from);
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@aiqsa.local>`;

  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    "",
    dotStuff(input.email.text)
  ].join("\r\n");
}

type SmtpPhaseTimeoutCode = "smtp_command_timeout" | "smtp_connect_timeout";
const SAFE_SMTP_ERROR_CODES = new Set([
  "smtp_command_timeout",
  "smtp_connect_timeout",
  "smtp_connection_closed",
  "smtp_connection_error",
  "smtp_total_timeout"
]);

function sanitizeSmtpError(error: unknown): Error {
  if (
    error instanceof Error &&
    (SAFE_SMTP_ERROR_CODES.has(error.message) || /^smtp_unexpected_response_\d{3}$/.test(error.message))
  ) {
    return error;
  }

  return new Error("smtp_connection_error");
}

class SmtpDeadline {
  private readonly expiresAt: number;

  constructor(totalTimeoutMs: number) {
    this.expiresAt = Date.now() + totalTimeoutMs;
  }

  phase(timeoutMs: number, phaseCode: SmtpPhaseTimeoutCode): { code: SmtpPhaseTimeoutCode | "smtp_total_timeout"; delayMs: number } {
    const remainingMs = this.expiresAt - Date.now();

    if (remainingMs <= 0) {
      throw new Error("smtp_total_timeout");
    }

    return remainingMs <= timeoutMs
      ? { code: "smtp_total_timeout", delayMs: remainingMs }
      : { code: phaseCode, delayMs: timeoutMs };
  }
}

const defaultSmtpConnector: SmtpConnector = {
  connectPlain(input) {
    return net.connect(input);
  },
  connectSecure(input) {
    return tls.connect({
      host: input.host,
      port: input.port,
      servername: input.host
    });
  },
  startTls(input) {
    return tls.connect({
      servername: input.host,
      socket: input.socket
    });
  }
};

class SmtpConnection {
  private buffer = "";
  private closingNormally = false;
  private readonly onLifecycleClose = () => {
    if (!this.closingNormally) {
      this.socketFailure ??= new Error("smtp_connection_closed");
    }
  };
  private readonly onLifecycleError = () => {
    this.socketFailure ??= new Error("smtp_connection_error");
  };
  private socket: Duplex;
  private socketFailure: Error | undefined;

  constructor(
    socket: Duplex,
    private readonly config: Pick<SmtpMailConfig, "commandTimeoutMs" | "connectTimeoutMs">,
    private readonly connector: SmtpConnector,
    private readonly deadline: SmtpDeadline
  ) {
    this.socket = socket;
    this.socket.setEncoding("utf8");
    this.attachLifecycle(socket);
  }

  async open(secure: boolean): Promise<void> {
    await this.waitForReady(secure ? "secureConnect" : "connect");
    await this.readResponse([220], this.config.connectTimeoutMs, "smtp_connect_timeout");
  }

  async ehlo(): Promise<void> {
    await this.command("EHLO aiqsa.local", [250]);
  }

  async startTls(host: string): Promise<void> {
    await this.command("STARTTLS", [220]);
    this.throwIfSocketFailed();
    const secureSocket = this.connector.startTls({
      host,
      socket: this.socket
    });
    if (this.socketFailure) {
      secureSocket.destroy();
      this.throwIfSocketFailed();
    }
    const plainSocket = this.socket;
    secureSocket.setEncoding("utf8");
    this.attachLifecycle(secureSocket);
    this.socket = secureSocket;
    this.detachLifecycle(plainSocket);
    this.buffer = "";
    await this.waitForReady("secureConnect");
  }

  async authPlain(user: string, password: string): Promise<void> {
    const payload = Buffer.from(`\0${user}\0${password}`, "utf8").toString("base64");

    await this.command(`AUTH PLAIN ${payload}`, [235]);
  }

  async sendMail(input: { email: AuthEmail; from: string }): Promise<void> {
    const fromAddress = mailAddress(input.from);
    const toAddress = mailAddress(input.email.to);

    await this.command(`MAIL FROM:<${fromAddress}>`, [250]);
    await this.command(`RCPT TO:<${toAddress}>`, [250, 251]);
    await this.command("DATA", [354]);
    this.throwIfSocketFailed();
    this.socket.write(`${buildSmtpMessage(input)}\r\n.\r\n`);
    await this.readResponse([250], this.config.commandTimeoutMs, "smtp_command_timeout");
  }

  async quit(): Promise<void> {
    this.throwIfSocketFailed();
    this.socket.write("QUIT\r\n");
    this.closingNormally = true;
    await this.readResponse([221], this.config.commandTimeoutMs, "smtp_command_timeout");
    await this.endNormally();
    this.detachLifecycle(this.socket);
  }

  destroy(): void {
    const socket = this.socket;

    try {
      socket.destroy();
    } finally {
      this.detachLifecycle(socket);
    }
  }

  private async command(command: string, expectedCodes: number[]): Promise<SmtpResponse> {
    this.throwIfSocketFailed();
    this.socket.write(`${command}\r\n`);

    return this.readResponse(expectedCodes, this.config.commandTimeoutMs, "smtp_command_timeout");
  }

  private async endNormally(): Promise<void> {
    const socket = this.socket;
    this.throwIfSocketFailed();

    if (socket.destroyed) {
      return;
    }

    const timeout = this.deadline.phase(this.config.commandTimeoutMs, "smtp_command_timeout");

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        socket.off("error", onError);
        socket.off("close", onClose);

        if (timer !== undefined) {
          clearTimeout(timer);
        }
      };
      const fail = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        reject(error);
      };
      const onClose = () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        resolve();
      };
      const onError = () => fail(new Error("smtp_connection_error"));

      timer = setTimeout(() => fail(new Error(timeout.code)), timeout.delayMs);
      socket.once("error", onError);
      socket.once("close", onClose);

      try {
        socket.end();
      } catch {
        fail(new Error("smtp_connection_error"));
      }
    });
  }

  private async waitForReady(event: "connect" | "secureConnect"): Promise<void> {
    const socket = this.socket;
    this.throwIfSocketFailed();
    const timeout = this.deadline.phase(this.config.connectTimeoutMs, "smtp_connect_timeout");

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        socket.off(event, onReady);
        socket.off("error", onError);
        socket.off("close", onClose);

        if (timer !== undefined) {
          clearTimeout(timer);
        }
      };
      const fail = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        reject(error);
      };
      const onReady = () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        resolve();
      };
      const onError = () => fail(new Error("smtp_connection_error"));
      const onClose = () => fail(new Error("smtp_connection_closed"));

      timer = setTimeout(() => fail(new Error(timeout.code)), timeout.delayMs);
      socket.once(event, onReady);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
  }

  private async readResponse(
    expectedCodes: number[],
    timeoutMs: number,
    timeoutCode: SmtpPhaseTimeoutCode
  ): Promise<SmtpResponse> {
    const socket = this.socket;
    this.throwIfSocketFailed();
    const timeout = this.deadline.phase(timeoutMs, timeoutCode);

    return new Promise((resolve, reject) => {
      const lines: string[] = [];
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);

        if (timer !== undefined) {
          clearTimeout(timer);
        }
      };
      const fail = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        reject(error);
      };
      const finish = (response: SmtpResponse) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();

        if (!expectedCodes.includes(response.code)) {
          reject(new Error(`smtp_unexpected_response_${response.code}`));
          return;
        }

        resolve(response);
      };
      const onError = () => fail(new Error("smtp_connection_error"));
      const onClose = () => fail(new Error("smtp_connection_closed"));
      const consumeLine = (line: string) => {
        lines.push(line);

        const match = /^(\d{3})([ -])/.exec(line);
        if (match?.[2] === " ") {
          finish({
            code: Number(match[1]),
            lines
          });
        }
      };
      const drain = () => {
        let newline = this.buffer.indexOf("\n");

        while (newline >= 0) {
          const line = this.buffer.slice(0, newline).replace(/\r$/, "");
          this.buffer = this.buffer.slice(newline + 1);
          consumeLine(line);
          newline = this.buffer.indexOf("\n");
        }
      };
      const onData = (chunk: string | Buffer) => {
        this.buffer += chunk.toString();
        drain();
      };

      timer = setTimeout(() => fail(new Error(timeout.code)), timeout.delayMs);
      socket.on("data", onData);
      socket.on("error", onError);
      socket.on("close", onClose);
      drain();
    });
  }

  private attachLifecycle(socket: Duplex): void {
    socket.on("error", this.onLifecycleError);
    socket.on("close", this.onLifecycleClose);
  }

  private detachLifecycle(socket: Duplex): void {
    socket.off("error", this.onLifecycleError);
    socket.off("close", this.onLifecycleClose);
  }

  private throwIfSocketFailed(): void {
    if (this.socketFailure) {
      throw this.socketFailure;
    }
  }
}

export function createSmtpAuthMailer(
  config: SmtpMailConfig,
  connector: SmtpConnector = defaultSmtpConnector
): AuthMailer {
  return {
    deliveryConfigured: config.configured,
    async send(email) {
      if (!config.configured) {
        return undefined;
      }

      let connection: SmtpConnection | undefined;
      let completed = false;
      let socket: Duplex | undefined;

      try {
        const deadline = new SmtpDeadline(config.totalTimeoutMs);
        socket = config.secure
          ? connector.connectSecure({ host: config.host, port: config.port })
          : connector.connectPlain({ host: config.host, port: config.port });
        connection = new SmtpConnection(socket, config, connector, deadline);
        await connection.open(config.secure);
        await connection.ehlo();

        if (config.startTls && !config.secure) {
          await connection.startTls(config.host);
          await connection.ehlo();
        }

        if (config.user || config.password) {
          await connection.authPlain(config.user, config.password);
        }

        await connection.sendMail({
          email,
          from: config.from
        });
        await connection.quit();
        completed = true;
      } catch (error) {
        throw sanitizeSmtpError(error);
      } finally {
        if (!completed) {
          if (connection) {
            connection.destroy();
          } else {
            socket?.destroy();
          }
        }
      }
    }
  };
}

export function createAuthMailer(
  env: Record<string, string | undefined> = process.env
): AuthMailer {
  if (isTestAuthEnabled(env)) {
    return createTestAuthMailer();
  }

  const config = getSmtpMailConfig(env);

  return config.configured ? createSmtpAuthMailer(config) : createNoopAuthMailer();
}
