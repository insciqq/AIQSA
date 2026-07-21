import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSmtpAuthMailer,
  getSmtpMailConfig,
  type AuthEmail,
  type SmtpConnector,
  type SmtpMailConfig
} from "./mailer";

class FakeSmtpSocket extends Duplex {
  destroyCalls = 0;
  endCalls = 0;
  readonly writes: string[] = [];
  onClientWrite: ((value: string) => void) | undefined;

  serverData(value: string): void {
    this.push(value);
  }

  override _destroy(_error: Error | null, callback: (error?: Error | null) => void): void {
    this.destroyCalls += 1;
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.endCalls += 1;
    callback();
    queueMicrotask(() => this.emit("close"));
  }

  override _read(): void {
    return undefined;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    const value = chunk.toString();
    this.writes.push(value);
    this.onClientWrite?.(value);
    callback();
  }
}

const email: AuthEmail = {
  subject: "Verify\r\nBcc: hidden@example.test",
  text: ".first line\n..second line\nhttps://example.test/verify?token=message-secret",
  to: "person@example.test\r\nBcc: hidden@example.test"
};

function smtpConfig(overrides: Partial<SmtpMailConfig> = {}): SmtpMailConfig {
  return {
    commandTimeoutMs: 20,
    configured: true,
    connectTimeoutMs: 10,
    from: "AIQSA <noreply@example.test>",
    host: "smtp.example.test",
    password: "smtp-password-secret",
    port: 587,
    secure: false,
    startTls: false,
    totalTimeoutMs: 100,
    user: "smtp-user",
    ...overrides
  };
}

function emitSoon(socket: FakeSmtpSocket, event: "connect" | "secureConnect"): void {
  queueMicrotask(() => socket.emit(event));
}

function replySoon(socket: FakeSmtpSocket, response: string, delayMs = 0): void {
  if (delayMs > 0) {
    setTimeout(() => socket.serverData(response), delayMs);
    return;
  }

  queueMicrotask(() => socket.serverData(response));
}

function installSuccessfulCommands(socket: FakeSmtpSocket, delayMs = 0, closeAfterQuit = false): void {
  socket.onClientWrite = (value) => {
    if (value.startsWith("EHLO ")) {
      replySoon(socket, "250 smtp.example.test\r\n", delayMs);
      return;
    }

    if (value.startsWith("STARTTLS")) {
      replySoon(socket, "220 ready for tls\r\n", delayMs);
      return;
    }

    if (value.startsWith("AUTH PLAIN ")) {
      replySoon(socket, "235 authenticated\r\n", delayMs);
      return;
    }

    if (value.startsWith("MAIL FROM:")) {
      replySoon(socket, "250 sender accepted\r\n", delayMs);
      return;
    }

    if (value.startsWith("RCPT TO:")) {
      replySoon(socket, "250 recipient accepted\r\n", delayMs);
      return;
    }

    if (value === "DATA\r\n") {
      replySoon(socket, "354 send message\r\n", delayMs);
      return;
    }

    if (value.endsWith("\r\n.\r\n")) {
      replySoon(socket, "250 queued\r\n", delayMs);
      return;
    }

    if (value === "QUIT\r\n") {
      if (closeAfterQuit) {
        queueMicrotask(() => {
          socket.serverData("221 closing\r\n");
          socket.emit("close");
        });
        return;
      }

      replySoon(socket, "221 closing\r\n", delayMs);
    }
  };
}

function expectClean(socket: FakeSmtpSocket): void {
  expect(socket.listenerCount("data")).toBe(0);
  expect(socket.listenerCount("error")).toBe(0);
  expect(socket.listenerCount("close")).toBe(0);
  expect(socket.listenerCount("connect")).toBe(0);
  expect(socket.listenerCount("secureConnect")).toBe(0);
}

describe("SMTP auth mailer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses bounded timeout configuration and falls back for invalid values", () => {
    expect(
      getSmtpMailConfig({
        AIQSA_SMTP_COMMAND_TIMEOUT_MS: "2300",
        AIQSA_SMTP_CONNECT_TIMEOUT_MS: "1200",
        AIQSA_SMTP_FROM: "noreply@example.test",
        AIQSA_SMTP_HOST: "smtp.example.test",
        AIQSA_SMTP_TOTAL_TIMEOUT_MS: "4500"
      })
    ).toMatchObject({
      commandTimeoutMs: 2300,
      configured: true,
      connectTimeoutMs: 1200,
      totalTimeoutMs: 4500
    });

    expect(
      getSmtpMailConfig({
        AIQSA_SMTP_COMMAND_TIMEOUT_MS: "1.5",
        AIQSA_SMTP_CONNECT_TIMEOUT_MS: "0",
        AIQSA_SMTP_TOTAL_TIMEOUT_MS: "600001"
      })
    ).toMatchObject({
      commandTimeoutMs: 15_000,
      configured: false,
      connectTimeoutMs: 10_000,
      totalTimeoutMs: 60_000
    });
  });

  it("keeps STARTTLS, AUTH, header cleaning, dot-stuffing, and normal QUIT cleanup", async () => {
    const plain = new FakeSmtpSocket();
    const secure = new FakeSmtpSocket();
    installSuccessfulCommands(plain);
    installSuccessfulCommands(secure);
    const connector: SmtpConnector = {
      connectPlain: vi.fn(() => {
        emitSoon(plain, "connect");
        replySoon(plain, "220 smtp.example.test\r\n");
        return plain;
      }),
      connectSecure: vi.fn(() => {
        throw new Error("unexpected implicit TLS connection");
      }),
      startTls: vi.fn(() => {
        emitSoon(secure, "secureConnect");
        return secure;
      })
    };

    await createSmtpAuthMailer(smtpConfig({ startTls: true }), connector).send(email);

    expect(connector.startTls).toHaveBeenCalledWith({
      host: "smtp.example.test",
      socket: plain
    });
    expect(plain.writes).toEqual(["EHLO aiqsa.local\r\n", "STARTTLS\r\n"]);
    expect(secure.writes[0]).toBe("EHLO aiqsa.local\r\n");
    expect(secure.writes.some((value) => value.startsWith("AUTH PLAIN "))).toBe(true);
    const message = secure.writes.find((value) => value.includes("MIME-Version: 1.0"));
    expect(message).toContain("Subject: Verify Bcc: hidden@example.test");
    expect(message).toContain("To: person@example.test Bcc: hidden@example.test");
    expect(message).toContain("\r\n..first line\r\n...second line\r\n");
    expect(secure.writes.at(-1)).toBe("QUIT\r\n");
    expect(secure.endCalls).toBe(1);
    expect(secure.destroyCalls).toBe(0);
    expectClean(plain);
    expectClean(secure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves implicit TLS delivery without attempting STARTTLS", async () => {
    const secure = new FakeSmtpSocket();
    installSuccessfulCommands(secure);
    const connector: SmtpConnector = {
      connectPlain: vi.fn(() => {
        throw new Error("unexpected plain connection");
      }),
      connectSecure: vi.fn(() => {
        emitSoon(secure, "secureConnect");
        replySoon(secure, "220 smtp.example.test\r\n");
        return secure;
      }),
      startTls: vi.fn(() => {
        throw new Error("unexpected STARTTLS upgrade");
      })
    };

    await createSmtpAuthMailer(smtpConfig({ secure: true, startTls: true }), connector).send(email);

    expect(connector.connectSecure).toHaveBeenCalledOnce();
    expect(connector.startTls).not.toHaveBeenCalled();
    expect(secure.endCalls).toBe(1);
    expect(secure.destroyCalls).toBe(0);
    expectClean(secure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts the server closing immediately after a valid QUIT response", async () => {
    const socket = new FakeSmtpSocket();
    installSuccessfulCommands(socket, 0, true);
    const connector: SmtpConnector = {
      connectPlain() {
        emitSoon(socket, "connect");
        replySoon(socket, "220 smtp.example.test\r\n");
        return socket;
      },
      connectSecure() {
        throw new Error("unexpected implicit TLS connection");
      },
      startTls() {
        throw new Error("unexpected STARTTLS upgrade");
      }
    };

    await createSmtpAuthMailer(smtpConfig({ password: "", user: "" }), connector).send(email);

    expect(socket.writes.at(-1)).toBe("QUIT\r\n");
    expect(socket.destroyCalls).toBe(0);
    expectClean(socket);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { label: "TCP connection", open: false, greeting: false, secure: false },
    { label: "server greeting", open: true, greeting: false, secure: false },
    { label: "implicit TLS handshake", open: false, greeting: false, secure: true }
  ])("bounds a stalled $label and destroys the socket", async ({ greeting, open, secure }) => {
    const socket = new FakeSmtpSocket();
    const connector: SmtpConnector = {
      connectPlain() {
        if (open) {
          emitSoon(socket, "connect");
        }
        if (greeting) {
          replySoon(socket, "220 smtp.example.test\r\n");
        }
        return socket;
      },
      connectSecure() {
        if (open) {
          emitSoon(socket, "secureConnect");
        }
        if (greeting) {
          replySoon(socket, "220 smtp.example.test\r\n");
        }
        return socket;
      },
      startTls() {
        throw new Error("unexpected STARTTLS upgrade");
      }
    };
    const result = createSmtpAuthMailer(smtpConfig({ secure }), connector)
      .send(email)
      .catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(10);

    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("smtp_connect_timeout");
    expect(socket.destroyCalls).toBe(1);
    expectClean(socket);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled SMTP command", async () => {
    const socket = new FakeSmtpSocket();
    const connector: SmtpConnector = {
      connectPlain() {
        emitSoon(socket, "connect");
        replySoon(socket, "220 smtp.example.test\r\n");
        return socket;
      },
      connectSecure() {
        throw new Error("unexpected implicit TLS connection");
      },
      startTls() {
        throw new Error("unexpected STARTTLS upgrade");
      }
    };
    const result = createSmtpAuthMailer(smtpConfig(), connector).send(email).catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(0);
    expect(socket.writes).toEqual(["EHLO aiqsa.local\r\n"]);
    await vi.advanceTimersByTimeAsync(20);

    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("smtp_command_timeout");
    expect(socket.destroyCalls).toBe(1);
    expectClean(socket);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("captures a socket error that arrives between completed SMTP phases", async () => {
    const socket = new FakeSmtpSocket();
    socket.onClientWrite = (value) => {
      if (!value.startsWith("EHLO ")) {
        return;
      }

      queueMicrotask(() => {
        socket.serverData("250 smtp.example.test\r\n");
        socket.emit("error", new Error("late socket secret"));
      });
    };
    const connector: SmtpConnector = {
      connectPlain() {
        emitSoon(socket, "connect");
        replySoon(socket, "220 smtp.example.test\r\n");
        return socket;
      },
      connectSecure() {
        throw new Error("unexpected implicit TLS connection");
      },
      startTls() {
        throw new Error("unexpected STARTTLS upgrade");
      }
    };

    const error = await createSmtpAuthMailer(smtpConfig(), connector)
      .send(email)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("smtp_connection_error");
    expect(socket.writes).toEqual(["EHLO aiqsa.local\r\n"]);
    expect(socket.destroyCalls).toBe(1);
    expectClean(socket);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled STARTTLS handshake and destroys the replacement socket", async () => {
    const plain = new FakeSmtpSocket();
    const secure = new FakeSmtpSocket();
    installSuccessfulCommands(plain);
    const connector: SmtpConnector = {
      connectPlain() {
        emitSoon(plain, "connect");
        replySoon(plain, "220 smtp.example.test\r\n");
        return plain;
      },
      connectSecure() {
        throw new Error("unexpected implicit TLS connection");
      },
      startTls() {
        return secure;
      }
    };
    const result = createSmtpAuthMailer(smtpConfig({ startTls: true }), connector)
      .send(email)
      .catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(0);
    expect(plain.writes).toContain("STARTTLS\r\n");
    await vi.advanceTimersByTimeAsync(10);

    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("smtp_connect_timeout");
    expect(plain.destroyCalls).toBe(0);
    expect(secure.destroyCalls).toBe(1);
    expectClean(plain);
    expectClean(secure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses one absolute deadline even while individual phases keep succeeding", async () => {
    const socket = new FakeSmtpSocket();
    installSuccessfulCommands(socket, 3);
    const connector: SmtpConnector = {
      connectPlain() {
        emitSoon(socket, "connect");
        replySoon(socket, "220 smtp.example.test\r\n", 3);
        return socket;
      },
      connectSecure() {
        throw new Error("unexpected implicit TLS connection");
      },
      startTls() {
        throw new Error("unexpected STARTTLS upgrade");
      }
    };
    const result = createSmtpAuthMailer(
      smtpConfig({ commandTimeoutMs: 8, connectTimeoutMs: 8, totalTimeoutMs: 10, user: "", password: "" }),
      connector
    )
      .send(email)
      .catch((caught: unknown) => caught);

    await vi.advanceTimersByTimeAsync(10);

    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("smtp_total_timeout");
    expect(socket.destroyCalls).toBe(1);
    expectClean(socket);
    expect(vi.getTimerCount()).toBe(1);
    vi.clearAllTimers();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sanitizes provider rejection, socket error, and socket close failures", async () => {
    const cases = [
      {
        expected: "smtp_unexpected_response_550",
        fail(socket: FakeSmtpSocket) {
          socket.serverData("550 raw smtp-password-secret message-secret person@example.test\r\n");
        }
      },
      {
        expected: "smtp_connection_error",
        fail(socket: FakeSmtpSocket) {
          socket.emit("error", new Error("smtp-password-secret message-secret person@example.test"));
        }
      },
      {
        expected: "smtp_connection_closed",
        fail(socket: FakeSmtpSocket) {
          socket.emit("close");
        }
      }
    ] as const;

    for (const testCase of cases) {
      const socket = new FakeSmtpSocket();
      socket.onClientWrite = () => queueMicrotask(() => testCase.fail(socket));
      const connector: SmtpConnector = {
        connectPlain() {
          emitSoon(socket, "connect");
          replySoon(socket, "220 smtp.example.test\r\n");
          return socket;
        },
        connectSecure() {
          throw new Error("unexpected implicit TLS connection");
        },
        startTls() {
          throw new Error("unexpected STARTTLS upgrade");
        }
      };
      const result = createSmtpAuthMailer(smtpConfig(), connector).send(email);

      const error = await result.catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(testCase.expected);
      expect((error as Error).message).not.toMatch(/smtp-password-secret|message-secret|person@example\.test/);
      expect(socket.destroyCalls).toBe(1);
      expectClean(socket);
      expect(vi.getTimerCount()).toBe(0);
    }

    const connectorFailure = createSmtpAuthMailer(smtpConfig(), {
      connectPlain() {
        throw new Error("smtp-password-secret message-secret person@example.test");
      },
      connectSecure() {
        throw new Error("unexpected implicit TLS connection");
      },
      startTls() {
        throw new Error("unexpected STARTTLS upgrade");
      }
    })
      .send(email)
      .catch((caught: unknown) => caught);

    const connectorError = await connectorFailure;
    expect(connectorError).toBeInstanceOf(Error);
    expect((connectorError as Error).message).toBe("smtp_connection_error");
  });

  it("does not open a socket when delivery is unconfigured", async () => {
    const connector: SmtpConnector = {
      connectPlain: vi.fn(() => new FakeSmtpSocket()),
      connectSecure: vi.fn(() => new FakeSmtpSocket()),
      startTls: vi.fn(() => new FakeSmtpSocket())
    };

    await createSmtpAuthMailer(smtpConfig({ configured: false }), connector).send(email);

    expect(connector.connectPlain).not.toHaveBeenCalled();
    expect(connector.connectSecure).not.toHaveBeenCalled();
    expect(connector.startTls).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
