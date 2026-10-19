import { describe, expect, it } from "vitest";
import {
  CONNECT_DEVICE_TOKEN_PATTERN,
  CONNECT_POLL_SECRET_PATTERN,
  CONNECT_USER_CODE_PATTERN
} from "@/lib/contracts/connect";
import { hashToken } from "../auth/token";
import {
  generateConnectUserCode,
  hashConnectUserCode,
  issueConnectDeviceToken,
  issueConnectPollSecret
} from "./tokens";

describe("AIQSA Connect secrets", () => {
  it("issues device tokens and poll secrets in the contract formats and stores only their SHA-256", () => {
    const token = issueConnectDeviceToken();
    const secret = issueConnectPollSecret();

    expect(token.value).toMatch(CONNECT_DEVICE_TOKEN_PATTERN);
    expect(token.hash).toBe(hashToken(token.value));
    expect(secret.value).toMatch(CONNECT_POLL_SECRET_PATTERN);
    expect(secret.hash).toBe(hashToken(secret.value));
    expect(issueConnectDeviceToken().value).not.toBe(token.value);
  });

  it("draws pairing codes from the unambiguous alphabet", () => {
    for (let index = 0; index < 200; index += 1) {
      expect(generateConnectUserCode()).toMatch(CONNECT_USER_CODE_PATTERN);
    }
  });

  it("keys the stored pairing code with the installation secret", () => {
    const hash = hashConnectUserCode("ABCD-EFGH", "secret-one");

    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashConnectUserCode("ABCD-EFGH", "secret-one")).toBe(hash);
    expect(hashConnectUserCode("ABCD-EFGH", "secret-two")).not.toBe(hash);
    expect(hash).not.toBe(hashToken("ABCD-EFGH"));
    expect(() => hashConnectUserCode("ABCD-EFGH", "")).toThrow("connect_user_code_secret_unavailable");
  });
});
