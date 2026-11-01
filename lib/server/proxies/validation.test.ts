// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PROXY_LIMITS } from "@/lib/contracts/proxies";
import { isProxyId, parseProxyCreate, parseProxyPatch, parseProxyUpdate, ProxyError } from "./validation";

const BASE = { host: "proxy.example.com", name: "Almaty", port: 1080, protocol: "socks5" };
const codeOf = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    return error instanceof ProxyError ? error.code : "other";
  }
  return "none";
};

describe("proxy input", () => {
  it("makes a new proxy canonical, with its defaults", () => {
    expect(parseProxyCreate({ ...BASE, country: "kz", domainHints: ["kz", ".KZ", "Ozon.ru."], host: " Proxy.Example.COM. ", login: "bob", name: "  Almaty ", password: " a b " }))
      .toEqual({ active: true, country: "KZ", domainHints: [".kz", "ozon.ru"], host: "proxy.example.com", login: "bob", name: "Almaty", password: " a b ", port: 1080, protocol: "socks5" });
    expect(parseProxyCreate(BASE)).toMatchObject({ active: true, country: null, domainHints: [], login: null, password: null });
  });

  it("reads a numeric host as the address it means", () => {
    expect(parseProxyCreate({ ...BASE, host: "0x7f.1" }).host).toBe("127.0.0.1");
  });

  it.each([
    [{ ...BASE, name: " " }, "proxy_name_invalid"],
    [{ ...BASE, name: "a".repeat(PROXY_LIMITS.nameMaxLength + 1) }, "proxy_name_invalid"],
    [{ ...BASE, name: "two\nlines" }, "proxy_name_invalid"],
    [{ host: "proxy.example.com", port: 1080, protocol: "socks5" }, "proxy_name_invalid"],
    [{ ...BASE, protocol: "socks4" }, "proxy_protocol_invalid"],
    [{ ...BASE, host: "user:pw@proxy.example.com" }, "proxy_host_invalid"],
    [{ ...BASE, host: "http://proxy.example.com" }, "proxy_host_invalid"],
    [{ ...BASE, port: 0 }, "proxy_port_invalid"],
    [{ ...BASE, port: "1080" }, "proxy_port_invalid"],
    [{ ...BASE, country: "KAZ" }, "proxy_country_invalid"],
    [{ ...BASE, domainHints: ["https://ozon.ru/"] }, "proxy_hint_invalid"],
    [{ ...BASE, domainHints: ["*.ru"] }, "proxy_hint_invalid"],
    [{ ...BASE, domainHints: Array.from({ length: PROXY_LIMITS.hintsPerProxy + 1 }, (_, index) => `site${index}.ru`) }, "proxy_hint_invalid"],
    [{ ...BASE, login: "a:b" }, "proxy_login_invalid"],
    [{ ...BASE, login: "é".repeat(PROXY_LIMITS.loginMaxLength) }, "proxy_login_invalid"],
    [{ ...BASE, password: "orphan" }, "proxy_login_invalid"],
    [{ ...BASE, login: "bob", password: "" }, "proxy_password_invalid"],
    [{ ...BASE, login: "bob", password: "line\nbreak" }, "proxy_password_invalid"],
    [{ ...BASE, login: "bob", password: "é".repeat(PROXY_LIMITS.passwordMaxLength) }, "proxy_password_invalid"],
    [{ ...BASE, active: "yes" }, "proxy_input_invalid"],
    [{ ...BASE, owner: "administrator" }, "proxy_input_invalid"],
    [[], "proxy_input_invalid"],
    [null, "proxy_input_invalid"]
  ])("refuses %j", (input, code) => {
    expect(codeOf(() => parseProxyCreate(input))).toBe(code);
  });

  it("keeps an update to what it names, a null clearing and an absent field keeping", () => {
    expect(parseProxyPatch({ password: null })).toEqual({ password: null });
    expect(parseProxyPatch({ active: false, domainHints: [] })).toEqual({ active: false, domainHints: [] });
    expect(parseProxyPatch({})).toEqual({});
    expect(codeOf(() => parseProxyPatch({ host: null }))).toBe("proxy_host_invalid");
    expect(parseProxyUpdate({ expectedVersion: 3, name: "New" })).toEqual({ expectedVersion: 3, patch: { name: "New" } });
    for (const expectedVersion of [0, "3", undefined, 1.5]) expect(codeOf(() => parseProxyUpdate({ expectedVersion }))).toBe("proxy_input_invalid");
  });

  it("carries no input in its error", () => {
    try {
      parseProxyCreate({ ...BASE, login: "bob", password: "synthetic-pass\n" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("synthetic-pass");
    }
  });

  it("tells a possible id from text", () => {
    expect(isProxyId("10000000-0000-4000-8000-000000000001")).toBe(true);
    for (const value of ["", "a/b", "../x", "a".repeat(129), 1, null]) expect(isProxyId(value)).toBe(false);
  });
});
