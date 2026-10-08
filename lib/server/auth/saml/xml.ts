import { DOMParser } from "@xmldom/xmldom";

export const SAML_PROTOCOL_NAMESPACE = "urn:oasis:names:tc:SAML:2.0:protocol";
export const SAML_ASSERTION_NAMESPACE = "urn:oasis:names:tc:SAML:2.0:assertion";
export const SAML_METADATA_NAMESPACE = "urn:oasis:names:tc:SAML:2.0:metadata";
export const XML_SIGNATURE_NAMESPACE = "http://www.w3.org/2000/09/xmldsig#";

/** SAML messages and metadata never carry a DTD; refusing one keeps entity expansion out. */
const DOCUMENT_TYPE = /<!DOCTYPE|<!ENTITY/iu;
/**
 * Real responses and metadata nest a dozen levels and hold at most a few thousand nodes; deeper
 * or larger documents only make canonicalization and signature checks expensive.
 */
export const SAML_XML_MAX_DEPTH = 64;
export const SAML_XML_MAX_NODES = 20_000;

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
  checkShape(document.documentElement);
  return document;
}

/** Refuses a document deeper or larger than SAML needs, before anything canonicalizes it. */
function checkShape(root: Node): void {
  const stack: Array<{ depth: number; node: Node }> = [{ depth: 1, node: root }];
  let nodes = 0;
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    nodes += 1;
    if (entry.depth > SAML_XML_MAX_DEPTH || nodes > SAML_XML_MAX_NODES) refuse();
    for (let child = entry.node.firstChild; child; child = child.nextSibling) {
      stack.push({ depth: entry.depth + 1, node: child });
    }
  }
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
