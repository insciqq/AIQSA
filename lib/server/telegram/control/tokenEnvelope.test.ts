import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptTelegramBotToken, encryptTelegramBotToken, isTelegramBotToken, TelegramTokenEnvelopeError, telegramTokenBotId
} from "./tokenEnvelope";

const TOKEN = "123456789:AAFakeTokenForTelegramEnvelopeTests_000";
const key = randomBytes(32);

describe("Telegram bot token envelope", () => {
  it("opens only under the generation and key that sealed it, and never holds the token in clear", () => {
    const envelope = encryptTelegramBotToken({ generation: 3, key, token: TOKEN });
    expect(envelope).not.toContain(TOKEN);
    expect(envelope).not.toContain(TOKEN.split(":")[1]);
    expect(decryptTelegramBotToken({ envelope, generation: 3, key })).toBe(TOKEN);
    expect(() => decryptTelegramBotToken({ envelope, generation: 2, key })).toThrow(TelegramTokenEnvelopeError);
    expect(() => decryptTelegramBotToken({ envelope, generation: 3, key: randomBytes(32) })).toThrow(TelegramTokenEnvelopeError);
    expect(() => decryptTelegramBotToken({ envelope: `${envelope}x`, generation: 3, key })).toThrow(TelegramTokenEnvelopeError);
    expect(() => decryptTelegramBotToken({ envelope: "", generation: 3, key })).toThrow(TelegramTokenEnvelopeError);
  });

  it("refuses values that are not bot tokens and generations outside the stored range", () => {
    expect(() => encryptTelegramBotToken({ generation: 1, key, token: "not-a-token" })).toThrow(TelegramTokenEnvelopeError);
    expect(() => encryptTelegramBotToken({ generation: 0, key, token: TOKEN })).toThrow(TelegramTokenEnvelopeError);
    expect(() => encryptTelegramBotToken({ generation: 2 ** 31, key, token: TOKEN })).toThrow(TelegramTokenEnvelopeError);
    expect(isTelegramBotToken(TOKEN)).toBe(true);
    expect(isTelegramBotToken(`${TOKEN}/../getMe`)).toBe(false);
    expect(telegramTokenBotId(TOKEN)).toBe(123456789);
  });
});
