import { DOMParser } from "@xmldom/xmldom";

export const SAML_PROTOCOL_NAMESPACE = "urn:oasis:names:tc:SAML:2.0:protocol";
export const SAML_ASSERTION_NAMESPACE = "urn:oasis:names:tc:SAML:2.0:assertion";
export const SAML_METADATA_NAMESPACE = "urn:oasis:names:tc:SAML:2.0:metadata";
export const XML_SIGNATURE_NAMESPACE = "http://www.w3.org/2000/09/xmldsig#";

/** SAML messages and metadata never carry a DTD; refusing one keeps entity expansion out. */
const DOCUMENT_TYPE = /<!DOCTYPE|<!ENTITY/iu;

export class SamlXmlError extends Error {
  constructor() {
    super("saml_xml_invalid");
    this.name = "SamlXmlError";
  }
}

function refuse(): never {
  throw new SamlXmlError();
}

/**
 * Parses untrusted SAML XML: bounded, without a DTD, and any parser error or warning is fatal.
 * node-saml parses the same text again with laxer settings, so a document this parser accepts
 * also never makes that one warn into the logs.
 */
export function parseSamlXml(text: string, maxLength: number): Document {
  if (text.length > maxLength || DOCUMENT_TYPE.test(text)) refuse();
  const document = new DOMParser({
    errorHandler: { error: refuse, fatalError: refuse, warning: refuse },
    locator: {}
  }).parseFromString(text, "text/xml") as Document | undefined;
  if (!document?.documentElement) refuse();
  return document;
}

/** The element children of `parent` with this namespace and local name, in document order. */
export function childElements(parent: Element, namespace: string, localName: string): Element[] {
  const children: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1) {
      const element = node as Element;
      if (element.namespaceURI === namespace && element.localName === localName) children.push(element);
    }
  }
  return children;
}

/** Every element below `root` with this local name, in any namespace. */
export function elementsByLocalName(root: Document | Element, localName: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", localName));
}
