// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  readTrustedHeaderEmail,
  readTrustedHeaderIdentity,
  trustedHeaderDomainHint,
  TRUSTED_HEADER_GROUPS_MAX_BYTES,
  TRUSTED_HEADER_GROUPS_MAX_VALUES
} from "./identityHeaders";

const config = {
  emailHeader: "X-Auth-Request-Email",
  groupsHeader: "X-Auth-Request-Groups",
  groupsSeparator: ",",
  nameHeader: "X-Auth-Request-Preferred-Username"
};

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("trusted header identity", () => {
  it("reads the normalized email, the display name and the listed groups", () => {
    expect(readTrustedHeaderIdentity(headers({
      "x-auth-request-email": "  Member@Example.COM ",
      "x-auth-request-groups": "staff, admins ,,staff",
      "x-auth-request-preferred-username": "Synthetic Member"
    }), config)).toEqual({
      identity: { displayName: "Synthetic Member", email: "member@example.com", groups: ["staff", "admins"] },
      status: "identity"
    });
  });

  it("decodes UTF-8 names and groups that arrive one byte per character", () => {
    const latin1 = (value: string) => Buffer.from(value, "utf8").toString("latin1");
    expect(readTrustedHeaderIdentity(headers({
      "x-auth-request-email": "member@example.com",
      "x-auth-request-groups": latin1("команда"),
      "x-auth-request-preferred-username": latin1("Синтетический Участник")
    }), config)).toMatchObject({
      identity: { displayName: "Синтетический Участник", groups: ["команда"] }
    });
  });

  it("tells a missing groups header (null) apart from an empty list", () => {
    expect(readTrustedHeaderIdentity(headers({ "x-auth-request-email": "member@example.com" }), config))
      .toMatchObject({ identity: { displayName: "", groups: null } });
    expect(readTrustedHeaderIdentity(headers({ "x-auth-request-email": "member@example.com", "x-auth-request-groups": "" }), config))
      .toMatchObject({ identity: { groups: [] } });
    expect(readTrustedHeaderIdentity(headers({ "x-auth-request-email": "member@example.com", "x-auth-request-groups": "staff" }), {
      ...config,
      groupsHeader: null
    })).toMatchObject({ identity: { groups: null } });
  });

  it("splits groups on the configured separator", () => {
    expect(readTrustedHeaderIdentity(headers({ "x-auth-request-email": "member@example.com", "x-auth-request-groups": "a,b|c" }), {
      ...config,
      groupsSeparator: "|"
    })).toMatchObject({ identity: { groups: ["a,b", "c"] } });
  });

  it("is missing without an email header or with a blank one", () => {
    expect(readTrustedHeaderIdentity(headers({}), config)).toEqual({ status: "missing" });
    expect(readTrustedHeaderIdentity(headers({ "x-auth-request-email": "   " }), config)).toEqual({ status: "missing" });
  });

  it.each([
    ["an oversized email", { "x-auth-request-email": `${"a".repeat(310)}@example.com` }],
    ["an implausible email", { "x-auth-request-email": "not-an-email" }],
    ["a repeated email header", { "x-auth-request-email": "one@example.com, two@example.com" }],
    ["a control character in the email", { "x-auth-request-email": "member\t@example.com" }],
    ["an oversized name", { "x-auth-request-email": "member@example.com", "x-auth-request-preferred-username": "n".repeat(161) }],
    ["oversized groups", {
      "x-auth-request-email": "member@example.com",
      "x-auth-request-groups": "g".repeat(TRUSTED_HEADER_GROUPS_MAX_BYTES + 1)
    }],
    ["too many groups", {
      "x-auth-request-email": "member@example.com",
      "x-auth-request-groups": Array.from({ length: TRUSTED_HEADER_GROUPS_MAX_VALUES + 1 }, (_, index) => `g${index}`).join(",")
    }],
    ["a control character in a group", { "x-auth-request-email": "member@example.com", "x-auth-request-groups": "staff,ad\tmins" }]
  ])("refuses %s as invalid", (_case, values) => {
    expect(readTrustedHeaderIdentity(headers(values), config)).toEqual({ status: "invalid" });
  });

  it("strips control characters from the display name", () => {
    expect(readTrustedHeaderIdentity(headers({
      "x-auth-request-email": "member@example.com",
      "x-auth-request-preferred-username": "Synthetic\tMember"
    }), config)).toMatchObject({ identity: { displayName: "Synthetic Member" } });
  });

  it("accepts exactly the bounds", () => {
    const groups = Array.from({ length: TRUSTED_HEADER_GROUPS_MAX_VALUES }, (_, index) => `g${index}`).join(",");
    expect(readTrustedHeaderIdentity(headers({
      "x-auth-request-email": "member@example.com",
      "x-auth-request-groups": groups,
      "x-auth-request-preferred-username": "n".repeat(160)
    }), config)).toMatchObject({ status: "identity" });
  });

  it("reduces an email to its domain for the admin probe", () => {
    const read = readTrustedHeaderEmail(headers({ "remote-email": "Admin@Example.com" }), "Remote-Email");
    expect(read).toEqual({ email: "admin@example.com", status: "email" });
    expect(trustedHeaderDomainHint("admin@example.com")).toBe("@example.com");
  });
});
