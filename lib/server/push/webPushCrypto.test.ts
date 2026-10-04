import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeBase64Url,
  encryptWebPushPayload,
  generateVapidKeyPair,
  isP256PublicKey,
  vapidAuthorization,
  WEB_PUSH_MAX_PLAINTEXT_BYTES
} from "./webPushCrypto";

const b64 = (value: string) => Buffer.from(value, "base64url");

/** RFC 8291 Appendix A. */
const RFC = {
  asPrivate: b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
  asPublic: b64("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
  auth: b64("BTBZMqHH6r4Tts7J_aSIgg"),
  message: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  plaintext: b64("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
  salt: b64("DGv6ra1nlYgDCS1FRnbzlw"),
  uaPrivate: b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
  uaPublic: b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
};

/** The user agent side of RFC 8291, written independently of the sender. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const secret = ua.computeSecret(senderPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), senderPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, auth, info, 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  const delimiter = padded.lastIndexOf(0x02);
  expect(padded.subarray(delimiter + 1).every((byte) => byte === 0)).toBe(true);
  return padded.subarray(0, delimiter);
}

describe("web push encryption", () => {
  it("reproduces the RFC 8291 example message exactly", () => {
    const body = encryptWebPushPayload(RFC.plaintext, { auth: RFC.auth, p256dh: RFC.uaPublic }, {
      salt: RFC.salt, senderPrivateKey: RFC.asPrivate
    });
    expect(body.toString("base64url")).toBe(RFC.message);
    expect(body.subarray(21, 86).equals(RFC.asPublic)).toBe(true);
    expect(body.readUInt32BE(16)).toBe(4096);
  });

  it("decrypts the RFC example and a fresh message with the user agent keys", () => {
    expect(decrypt(b64(RFC.message), RFC.uaPrivate, RFC.auth).equals(RFC.plaintext)).toBe(true);
    const payload = Buffer.from(JSON.stringify({ title: "Chat", body: "Answer ready" }));
    const first = encryptWebPushPayload(payload, { auth: RFC.auth, p256dh: RFC.uaPublic });
    const second = encryptWebPushPayload(payload, { auth: RFC.auth, p256dh: RFC.uaPublic });
    expect(first.equals(second)).toBe(false);
    expect(decrypt(first, RFC.uaPrivate, RFC.auth).equals(payload)).toBe(true);
  });

  it("refuses oversized payloads and malformed subscription keys", () => {
    const keys = { auth: RFC.auth, p256dh: RFC.uaPublic };
    expect(() => encryptWebPushPayload(Buffer.alloc(WEB_PUSH_MAX_PLAINTEXT_BYTES + 1), keys)).toThrow("web_push_payload_too_large");
    expect(() => encryptWebPushPayload(Buffer.from("x"), { ...keys, auth: Buffer.alloc(8) })).toThrow("web_push_subscription_invalid");
    expect(isP256PublicKey(RFC.uaPublic)).toBe(true);
    const offCurve = Buffer.from(RFC.uaPublic);
    offCurve[64] ^= 0x01;
    expect(isP256PublicKey(offCurve)).toBe(false);
    expect(isP256PublicKey(RFC.uaPublic.subarray(1))).toBe(false);
  });

  it("decodes only canonical base64url", () => {
    expect(decodeBase64Url("AQID")?.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(decodeBase64Url("AQID=")).toBeNull();
    expect(decodeBase64Url("AQ+D")).toBeNull();
  });
});

describe("VAPID", () => {
  it("signs an ES256 token for the push service origin that the public key verifies", () => {
    const keys = generateVapidKeyPair();
    expect(decodeBase64Url(keys.publicKey)).toHaveLength(65);
    expect(decodeBase64Url(keys.privateKey)).toHaveLength(32);
    const now = new Date("2026-10-04T12:00:00.000Z");
    const header = vapidAuthorization({ audience: "https://push.example", keys, now, subject: "https://aiqsa.example" });
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/u.exec(header);
    expect(match).not.toBeNull();
    const [, encodedHeader, encodedClaims, encodedSignature, key] = match!;
    expect(key).toBe(keys.publicKey);
    expect(JSON.parse(b64(encodedHeader!).toString())).toEqual({ alg: "ES256", typ: "JWT" });
    expect(JSON.parse(b64(encodedClaims!).toString())).toEqual({
      aud: "https://push.example", exp: Math.floor(now.getTime() / 1000) + 43_200, sub: "https://aiqsa.example"
    });
    const point = b64(keys.publicKey);
    const publicKey = createPublicKey({ format: "jwk", key: {
      crv: "P-256", kty: "EC", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url")
    } });
    expect(verify("sha256", Buffer.from(`${encodedHeader}.${encodedClaims}`),
      { dsaEncoding: "ieee-p1363", key: publicKey }, b64(encodedSignature!))).toBe(true);
  });
});
