// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseSamlXml, SAML_XML_MAX_DEPTH, SAML_XML_MAX_NODES, SamlXmlError } from "./xml";

const MAX_LENGTH = 192 * 1024;

describe("SAML XML parsing", () => {
  it("parses an ordinary document", () => {
    expect(parseSamlXml("<a><b><c>text</c></b></a>", MAX_LENGTH).documentElement.localName).toBe("a");
  });

  it("refuses a DTD before parsing", () => {
    expect(() => parseSamlXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>', MAX_LENGTH)).toThrow(SamlXmlError);
  });

  it("refuses nesting deeper than SAML needs, so canonicalization never walks it", () => {
    const deep = (levels: number) => `${"<x>".repeat(levels)}z${"</x>".repeat(levels)}`;
    expect(parseSamlXml(deep(SAML_XML_MAX_DEPTH - 1), MAX_LENGTH).documentElement.localName).toBe("x");
    expect(() => parseSamlXml(deep(SAML_XML_MAX_DEPTH + 1), MAX_LENGTH)).toThrow(SamlXmlError);
    expect(() => parseSamlXml(deep(25_000), MAX_LENGTH)).toThrow(SamlXmlError);
  });

  it("refuses more nodes than SAML needs", () => {
    const wide = `<a>${"<b/>".repeat(SAML_XML_MAX_NODES)}</a>`;
    expect(() => parseSamlXml(wide, MAX_LENGTH)).toThrow(SamlXmlError);
  });
});
