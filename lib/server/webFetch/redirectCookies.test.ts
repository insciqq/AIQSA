import { describe, expect, it } from "vitest";
import { RedirectCookieJar } from "./redirectCookies";

const origin = new URL("https://shop.example.co.uk/catalog/start");
const now = Date.parse("2026-11-02T12:00:00Z");
function store(jar: RedirectCookieJar, values: string[], url = origin, time = now) {
  const headers = new Headers();
  for (const value of values) headers.append("set-cookie", value);
  jar.store(url, headers, time);
}
const header = (jar: RedirectCookieJar, url = origin.href, time = now) => jar.header(new URL(url), time);

describe("cookies scoped to one redirect chain", () => {
  it("distinguishes host-only and Domain cookies, including private public suffixes", () => {
    const jar = new RedirectCookieJar();
    store(jar, ["host=one; Path=/", "site=two; Domain=.EXAMPLE.CO.UK; Path=/", "narrow=three; Domain=shop.example.co.uk; Path=/"]);
    expect(header(jar)).toBe("host=one; site=two; narrow=three");
    expect(header(jar, "https://child.shop.example.co.uk/")).toBe("site=two; narrow=three");
    expect(header(jar, "https://other.example.co.uk/")).toBe("site=two");
    for (const target of ["https://example.org/", "https://example.co.uk.attacker.com/", "https://badexample.co.uk/"]) {
      expect(header(jar, target)).toBeNull();
    }
    store(jar, ["bad=one; Domain=co.uk", "bad=two; Domain=example.org", "bad=three; Domain=child.shop.example.co.uk",
      "bad=four; Domain=", "bad=five; Domain=example.co.uk.", "bad=six; Domain=..example.co.uk"]);
    expect(header(jar)).not.toContain("bad=");
    const tenant = new URL("https://alice.github.io/");
    store(jar, ["tenant=one; Domain=alice.github.io", "bad=seven; Domain=github.io"], tenant);
    expect(header(jar, tenant.href)).toBe("tenant=one");
    expect(header(jar, "https://bob.github.io/")).toBeNull();
    // A nested private suffix can begin a different site beneath a cookie's Domain.
    store(jar, ["parent=one; Domain=amazonaws.com; Path=/"], new URL("https://amazonaws.com/"));
    expect(header(jar, "https://bucket.s3.amazonaws.com/")).toBeNull();
  });

  it("keeps literal addresses host-only and handles internationalized domains", () => {
    const jar = new RedirectCookieJar();
    store(jar, ["host=one; Path=/", "bad=two; Domain=93.184.216.34"], new URL("https://93.184.216.34/"));
    expect(header(jar, "https://93.184.216.34/")).toBe("host=one");
    expect(header(jar, "https://93.184.216.35/")).toBeNull();
    const international = new URL("https://shop.xn--bcher-kva.de/");
    store(jar, ["book=one; Domain=xn--bcher-kva.de"], international);
    expect(header(jar, "https://bücher.de/")).toBe("book=one");
  });

  it("matches explicit and default paths on directory boundaries, longest first", () => {
    const jar = new RedirectCookieJar();
    store(jar, ["id=root; Path=/", "id=catalog", "item=one; Path=/catalog/item", "invalid=default; Path=relative"]);
    expect(header(jar, "https://shop.example.co.uk/catalog/item/details")).toBe("item=one; id=catalog; invalid=default; id=root");
    expect(header(jar, "https://shop.example.co.uk/catalogue")).toBe("id=root");
    expect(header(jar, "https://shop.example.co.uk/catalog")).toBe("id=catalog; invalid=default; id=root");
    expect(header(jar, "https://shop.example.co.uk/catalog/items")).not.toContain("item=");
  });

  it("sends Secure cookies only over HTTPS and refuses insecure origins setting them", () => {
    const jar = new RedirectCookieJar();
    store(jar, ["secure=yes; Secure; Path=/", "plain=yes; Path=/", "__Secure-id=ok; Secure; Path=/",
      "__Host-id=ok; Secure; Path=/", "__Secure-bad=no", "__Host-bad=no; Secure; Domain=example.co.uk; Path=/"]);
    expect(header(jar)).toBe("secure=yes; plain=yes; __Secure-id=ok; __Host-id=ok");
    expect(header(jar, "http://shop.example.co.uk/")).toBe("plain=yes");
    store(jar, ["bad=no; Secure; Path=/", "secure=overwrite; Path=/"], new URL("http://shop.example.co.uk/"));
    expect(header(jar)).not.toContain("bad=");
    expect(header(jar)).toContain("secure=yes");
    expect(header(jar)).not.toContain("overwrite");
  });

  it("honours expiry, replacement, deletion and Max-Age precedence over Expires", () => {
    const jar = new RedirectCookieJar();
    store(jar, ["expired=no; Expires=Sun, 01 Nov 2026 12:00:00 GMT", "future=yes; Expires=Tue, 03 Nov 2026 12:00:00 GMT",
      "short=yes; Max-Age=2; Expires=Sun, 01 Nov 2026 12:00:00 GMT", "deleted=no; Max-Age=0; Expires=Tue, 03 Nov 2026 12:00:00 GMT"]);
    expect(header(jar)).toBe("future=yes; short=yes");
    expect(header(jar, origin.href, now + 2000)).toBe("future=yes");
    store(jar, ["future=updated"]);
    expect(header(jar)).toBe("future=updated");
    store(jar, ["future=; Max-Age=-1"]);
    expect(header(jar)).toBeNull();
  });

  it("bounds cookie count, stored bytes and each field, ignoring malformed cookies", () => {
    const jar = new RedirectCookieJar();
    store(jar, Array.from({ length: 100 }, (_, i) => `c${i}=value; Path=/`));
    expect(header(jar)!.split("; ").length).toBeLessThanOrEqual(32);
    store(jar, Array.from({ length: 10 }, (_, i) => `large${i}=${"x".repeat(3000)}; Path=/`));
    expect(Buffer.byteLength(header(jar)!)).toBeLessThanOrEqual(8192);
    const before = header(jar);
    store(jar, [`oversized=${"x".repeat(4096)}`, "bad name=value", "no-equals", 'bad="unterminated', "bad=has space",
      "bad=has,comma", "bad=back\\slash"]);
    expect(header(jar)).toBe(before);
    expect(JSON.stringify(jar)).toBe("{}");
    jar.clear();
    expect(header(jar)).toBeNull();
  });
});
