import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SmtpCompleteConfiguration, SmtpProductMessage } from "./definitions";
import {
  createSmtpTransport,
  type SmtpConnector,
  type SmtpResolvedAddress,
  type SmtpStartTlsInput,
  type SmtpTlsConnectionInput,
  type SmtpTransportLimits
} from "./smtpTransport";

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

const PUBLIC_ADDRESS: SmtpResolvedAddress = { address: "93.184.216.34", family: 4 };
const PRIVATE_ADDRESS: SmtpResolvedAddress = { address: "10.20.30.40", family: 4 };

const passwordConfiguration: SmtpCompleteConfiguration = {
  allowInternalNetwork: false,
  authentication: {
    mode: "password",
    password: "smtp-password-secret",
    username: "smtp-user"
  },
  from: { address: "noreply@example.test", displayName: "AIQSA" },
  host: "smtp.example.test",
  port: 587,
  transport: "starttls_required"
};

const noAuthConfiguration: SmtpCompleteConfiguration = {
  allowInternalNetwork: true,
  authentication: { mode: "none" },
  from: { address: "noreply@example.test", displayName: null },
  host: "smtp.internal",
  port: 25,
  transport: "plaintext_internal_no_auth"
};

const message: SmtpProductMessage = {
  kind: "configuration_test",
  subject: "AIQSA email delivery test",
  text: "This is an AIQSA configuration test.",
  to: "admin@example.test"
};

const TEST_LIMITS: Partial<SmtpTransportLimits> = {
  commandTimeoutMs: 100,
  connectTimeoutMs: 100,
  totalTimeoutMs: 1_000
};

function connected(socket: FakeSmtpSocket, secure: boolean, banner = true): void {
  queueMicrotask(() => {
    socket.emit(secure ? "secureConnect" : "connect");
    if (banner) socket.serverData("220 smtp.example.test ready\r\n");
  });
}

function reply(socket: FakeSmtpSocket, value: string): void {
  queueMicrotask(() => socket.serverData(value));
}

function installDeliveryScript(
  socket: FakeSmtpSocket,
  input: {
    capabilities?: string;
    finalData?: "accept" | "close" | "malformed" | "reject" | "stall";
    quit?: "accept" | "close";
  } = {}
): void {
  socket.onClientWrite = (value) => {
    if (value.startsWith("EHLO ")) {
      reply(socket, input.capabilities ?? "250-smtp.example.test\r\n250 AUTH PLAIN\r\n");
    } else if (value.startsWith("AUTH PLAIN ")) {
      reply(socket, "235 authenticated\r\n");
    } else if (value.startsWith("MAIL FROM:")) {
      reply(socket, "250 sender accepted\r\n");
    } else if (value.startsWith("RCPT TO:")) {
      reply(socket, "250 recipient accepted\r\n");
    } else if (value === "DATA\r\n") {
      reply(socket, "354 continue\r\n");
    } else if (value.endsWith("\r\n.\r\n")) {
      if (input.finalData === "close") {
        queueMicrotask(() => socket.emit("close"));
      } else if (input.finalData === "malformed") {
        reply(socket, "not an smtp reply\r\n");
      } else if (input.finalData === "reject") {
        reply(socket, "550 rejected\r\n");
      } else if (input.finalData === "stall") {
        return;
      } else {
        reply(socket, "250 queued\r\n");
      }
    } else if (value === "QUIT\r\n") {
      if (input.quit === "close") {
        queueMicrotask(() => socket.emit("close"));
      } else {
        reply(socket, "221 closing\r\n");
      }
    }
  };
}

function unusedConnector(): SmtpConnector {
  return {
    connectPlain: vi.fn(() => {
      throw new Error("unexpected plain connection");
    }),
    connectTls: vi.fn(() => {
      throw new Error("unexpected TLS connection");
    }),
    startTls: vi.fn(() => {
      throw new Error("unexpected STARTTLS upgrade");
    })
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SMTP TLS, authentication, and pinning", () => {
  it("pins DNS, requires advertised STARTTLS, verifies TLS identity, EHLOs again, and authenticates only after TLS", async () => {
    const plain = new FakeSmtpSocket();
    const secure = new FakeSmtpSocket();
    plain.onClientWrite = (value) => {
      if (value.startsWith("EHLO ")) {
        reply(plain, "250-smtp.example.test\r\n250 STARTTLS\r\n");
      } else if (value === "STARTTLS\r\n") {
        reply(plain, "220 begin tls\r\n");
      }
    };
    installDeliveryScript(secure, { quit: "close" });

    const connector: SmtpConnector = {
      connectPlain: vi.fn(() => {
        connected(plain, false);
        return plain;
      }),
      connectTls: vi.fn(() => {
        throw new Error("unexpected implicit TLS connection");
      }),
      startTls: vi.fn(() => {
        connected(secure, true, false);
        return secure;
      })
    };
    const resolveHostname = vi.fn(async () => [PUBLIC_ADDRESS]);
    const outcome = await createSmtpTransport({
      connector,
      limits: TEST_LIMITS,
      resolveHostname
    }).send({ configuration: passwordConfiguration, message });

    expect(outcome).toEqual({ kind: "accepted" });
    expect(resolveHostname).toHaveBeenCalledExactlyOnceWith("smtp.example.test");
    expect(connector.connectPlain).toHaveBeenCalledWith({
      ...PUBLIC_ADDRESS,
      hostname: "smtp.example.test",
      port: 587
    });
    expect(connector.startTls).toHaveBeenCalledWith({
      hostname: "smtp.example.test",
      rejectUnauthorized: true,
      servername: "smtp.example.test",
      socket: plain,
      verificationHost: "smtp.example.test"
    } satisfies SmtpStartTlsInput);
    expect(plain.writes).toEqual(["EHLO aiqsa.local\r\n", "STARTTLS\r\n"]);
    expect(plain.writes.join("\n")).not.toContain("smtp-password-secret");
    expect(secure.writes[0]).toBe("EHLO aiqsa.local\r\n");
    expect(secure.writes.some((value) => value.startsWith("AUTH PLAIN "))).toBe(true);
    expect(secure.writes.at(-1)).toBe("QUIT\r\n");
  });

  it("fails closed when STARTTLS or AUTH PLAIN is not advertised", async () => {
    for (const capabilities of [
      "250 smtp.example.test\r\n",
      "250-smtp.example.test\r\n250 STARTTLS\r\n"
    ]) {
      const plain = new FakeSmtpSocket();
      const secure = new FakeSmtpSocket();
      plain.onClientWrite = (value) => {
        if (value.startsWith("EHLO ")) reply(plain, capabilities);
        if (value === "STARTTLS\r\n") reply(plain, "220 begin tls\r\n");
      };
      installDeliveryScript(secure, { capabilities: "250 smtp.example.test\r\n" });
      const connector: SmtpConnector = {
        connectPlain: () => {
          connected(plain, false);
          return plain;
        },
        connectTls: () => {
          throw new Error("unexpected");
        },
        startTls: vi.fn(() => {
          connected(secure, true, false);
          return secure;
        })
      };

      const outcome = await createSmtpTransport({
        connector,
        limits: TEST_LIMITS,
        resolveHostname: async () => [PUBLIC_ADDRESS]
      }).send({ configuration: passwordConfiguration, message });

      expect(outcome).toEqual({
        code: capabilities.includes("STARTTLS")
          ? "smtp_authentication_unavailable"
          : "smtp_starttls_unavailable",
        kind: "failed"
      });
      if (!capabilities.includes("STARTTLS")) expect(connector.startTls).not.toHaveBeenCalled();
      expect(plain.writes.some((value) => value.startsWith("AUTH PLAIN "))).toBe(false);
    }
  });

  it("uses implicit verified TLS before the greeting and authentication", async () => {
    const secure = new FakeSmtpSocket();
    installDeliveryScript(secure);
    const connector = unusedConnector();
    connector.connectTls = vi.fn((input: SmtpTlsConnectionInput) => {
      connected(secure, true);
      return secure;
    });
    const configuration: SmtpCompleteConfiguration = {
      ...passwordConfiguration,
      port: 465,
      transport: "implicit_tls"
    };

    await expect(createSmtpTransport({
      connector,
      limits: TEST_LIMITS,
      resolveHostname: async () => [PUBLIC_ADDRESS]
    }).send({ configuration, message })).resolves.toEqual({ kind: "accepted" });
    expect(connector.connectTls).toHaveBeenCalledWith({
      ...PUBLIC_ADDRESS,
      hostname: "smtp.example.test",
      port: 465,
      rejectUnauthorized: true,
      servername: "smtp.example.test",
      verificationHost: "smtp.example.test"
    } satisfies SmtpTlsConnectionInput);
    expect(connector.connectPlain).not.toHaveBeenCalled();
  });
});

describe("SMTP destination policy and bounded input", () => {
  it("allows credential-free plaintext only when every pinned answer is internal", async () => {
    const socket = new FakeSmtpSocket();
    installDeliveryScript(socket, { capabilities: "250 smtp.internal\r\n" });
    const connector = unusedConnector();
    connector.connectPlain = vi.fn(() => {
      connected(socket, false);
      return socket;
    });

    await expect(createSmtpTransport({
      connector,
      limits: TEST_LIMITS,
      resolveHostname: async () => [PRIVATE_ADDRESS]
    }).send({ configuration: noAuthConfiguration, message })).resolves.toEqual({ kind: "accepted" });
    expect(socket.writes.some((value) => value.startsWith("AUTH "))).toBe(false);
  });

  it.each([
    [{ address: "93.184.216.34", family: 4 as const }],
    [{ address: "169.254.169.254", family: 4 as const }],
    [{ address: "fe80::1", family: 6 as const }],
    [{ address: "224.0.0.1", family: 4 as const }]
  ])("rejects a public or dangerous plaintext destination %# before connect", async (record) => {
    const connector = unusedConnector();
    const outcome = await createSmtpTransport({
      connector,
      limits: TEST_LIMITS,
      resolveHostname: async () => [record]
    }).send({ configuration: noAuthConfiguration, message });

    expect(outcome).toEqual({ code: "smtp_address_forbidden", kind: "failed" });
    expect(connector.connectPlain).not.toHaveBeenCalled();
  });

  it("fails closed for mixed public/private DNS answers without approval", async () => {
    const connector = unusedConnector();
    const outcome = await createSmtpTransport({
      connector,
      limits: TEST_LIMITS,
      resolveHostname: async () => [PUBLIC_ADDRESS, PRIVATE_ADDRESS]
    }).send({ configuration: passwordConfiguration, message });

    expect(outcome).toEqual({ code: "smtp_address_forbidden", kind: "failed" });
    expect(connector.connectPlain).not.toHaveBeenCalled();
  });

  it("bounds and validates DNS answers before address classification or connect", async () => {
    for (const records of [
      [],
      Array.from({ length: 33 }, () => PUBLIC_ADDRESS),
      [{ address: "not-an-ip", family: 4 as const }]
    ]) {
      const connector = unusedConnector();
      const outcome = await createSmtpTransport({
        connector,
        limits: TEST_LIMITS,
        resolveHostname: async () => records
      }).send({ configuration: passwordConfiguration, message });

      expect(outcome).toEqual({ code: "smtp_dns_failed", kind: "failed" });
      expect(connector.connectPlain).not.toHaveBeenCalled();
    }
  });

  it("rejects header injection before DNS or socket work", async () => {
    const connector = unusedConnector();
    const resolveHostname = vi.fn(async () => [PUBLIC_ADDRESS]);
    const outcome = await createSmtpTransport({ connector, resolveHostname }).send({
      configuration: passwordConfiguration,
      message: {
        ...message,
        subject: "Test\r\nBcc: hidden@example.test"
      }
    });

    expect(outcome).toEqual({ code: "smtp_invalid_input", kind: "failed" });
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it("destroys the socket when an untrusted reply exceeds the line bound", async () => {
    const socket = new FakeSmtpSocket();
    const connector = unusedConnector();
    connector.connectPlain = () => {
      connected(socket, false, false);
      queueMicrotask(() => socket.serverData(`220 ${"x".repeat(40)}\r\n`));
      return socket;
    };
    const outcome = await createSmtpTransport({
      connector,
      limits: { ...TEST_LIMITS, maxReplyLineBytes: 16 },
      resolveHostname: async () => [PRIVATE_ADDRESS]
    }).send({ configuration: noAuthConfiguration, message });

    expect(outcome).toEqual({ code: "smtp_reply_limit", kind: "failed" });
    expect(socket.destroyCalls).toBeGreaterThan(0);
  });

  it.each([
    { limits: { maxReplyLines: 2 }, reply: "250-one\r\n250 two\r\n" },
    { limits: { maxReplyBytes: 30 }, reply: `250 ${"x".repeat(24)}\r\n` }
  ])("bounds cumulative SMTP reply input %#", async ({ limits, reply: ehloReply }) => {
    const socket = new FakeSmtpSocket();
    socket.onClientWrite = (value) => {
      if (value.startsWith("EHLO ")) reply(socket, ehloReply);
    };
    const connector = unusedConnector();
    connector.connectPlain = () => {
      connected(socket, false);
      return socket;
    };
    const outcome = await createSmtpTransport({
      connector,
      limits: { ...TEST_LIMITS, ...limits },
      resolveHostname: async () => [PRIVATE_ADDRESS]
    }).send({ configuration: noAuthConfiguration, message });

    expect(outcome).toEqual({ code: "smtp_reply_limit", kind: "failed" });
    expect(socket.destroyCalls).toBeGreaterThan(0);
  });
});

describe("SMTP DATA acceptance boundary", () => {
  function implicitAttempt(
    finalData: "accept" | "close" | "malformed" | "reject" | "stall",
    quit: "accept" | "close" = "accept",
    limits: Partial<SmtpTransportLimits> = TEST_LIMITS
  ) {
    const socket = new FakeSmtpSocket();
    installDeliveryScript(socket, { finalData, quit });
    const connector = unusedConnector();
    connector.connectTls = vi.fn(() => {
      connected(socket, true);
      return socket;
    });
    const configuration: SmtpCompleteConfiguration = {
      ...passwordConfiguration,
      port: 465,
      transport: "implicit_tls"
    };
    return {
      connector,
      operation: createSmtpTransport({
        connector,
        limits,
        resolveHostname: async () => [PUBLIC_ADDRESS]
      }).send({ configuration, message }),
      socket
    };
  }

  it("marks disconnect or unreadable reply after DATA as ambiguous and never retries", async () => {
    for (const finalData of ["close", "malformed"] as const) {
      const attempt = implicitAttempt(finalData);
      await expect(attempt.operation).resolves.toEqual({ kind: "ambiguous_after_data" });
      expect(attempt.connector.connectTls).toHaveBeenCalledOnce();
      expect(attempt.socket.writes.filter((value) => value === "DATA\r\n")).toHaveLength(1);
    }
  });

  it("reports an explicit post-DATA rejection as failed rather than ambiguous", async () => {
    const attempt = implicitAttempt("reject");
    await expect(attempt.operation).resolves.toEqual({
      code: "smtp_data_rejected",
      kind: "failed"
    });
    expect(attempt.connector.connectTls).toHaveBeenCalledOnce();
  });

  it("marks a post-DATA terminal-reply timeout as ambiguous", async () => {
    vi.useFakeTimers();
    const attempt = implicitAttempt("stall", "accept", {
      commandTimeoutMs: 10,
      connectTimeoutMs: 10,
      totalTimeoutMs: 100
    });

    await vi.advanceTimersByTimeAsync(11);
    await expect(attempt.operation).resolves.toEqual({ kind: "ambiguous_after_data" });
    expect(attempt.connector.connectTls).toHaveBeenCalledOnce();
  });

  it("accepts exactly at the terminal 250 and ignores a later QUIT close", async () => {
    const attempt = implicitAttempt("accept", "close");
    await expect(attempt.operation).resolves.toEqual({ kind: "accepted" });
    expect(attempt.socket.writes.at(-1)).toBe("QUIT\r\n");
  });

  it("bounds a stalled pre-DATA command as a failure", async () => {
    vi.useFakeTimers();
    const socket = new FakeSmtpSocket();
    socket.onClientWrite = () => undefined;
    const connector = unusedConnector();
    connector.connectTls = () => {
      connected(socket, true);
      return socket;
    };
    const configuration: SmtpCompleteConfiguration = {
      ...passwordConfiguration,
      port: 465,
      transport: "implicit_tls"
    };
    const operation = createSmtpTransport({
      connector,
      limits: {
        commandTimeoutMs: 10,
        connectTimeoutMs: 10,
        totalTimeoutMs: 100
      },
      resolveHostname: async () => [PUBLIC_ADDRESS]
    }).send({ configuration, message });

    await vi.advanceTimersByTimeAsync(11);
    await expect(operation).resolves.toEqual({ code: "smtp_command_timeout", kind: "failed" });
  });
});
