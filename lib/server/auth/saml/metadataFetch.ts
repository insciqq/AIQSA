import { SAML_METADATA_XML_MAX_LENGTH } from "@/lib/contracts/samlSignIn";
import { readBoundedRequestBody } from "../../http/requestBody";
import { PERSONAL_MCP_EGRESS_HEADERS } from "../../mcp/personalEgress";
import {
  buildPersonalMcpNetworkEnvironment,
  createPersonalMcpAddressPolicy,
  defaultPersonalMcpNetworkHost,
  type PersonalMcpAddressPolicyState
} from "../../mcp/personalNetworkPolicy";
import { createMcpSafeFetch, networkAddressScope, type McpSafeFetchOptions } from "../../mcp/safeFetch";
import { SamlMetadataFetchError, usableSamlUrl } from "./metadata";

let metadataAddressPolicy: PersonalMcpAddressPolicyState | null = null;

/**
 * Where metadata may come from: the administrator chose the URL, so the local network is open;
 * AIQSA's own services, the app container and cloud metadata never are (the personal MCP rules
 * with local access on). Plain HTTP reaches only local addresses: metadata from the internet
 * carries the certificates AIQSA will trust, so it needs TLS. Every hop is DNS-pinned and
 * checked again.
 */
export function createSamlMetadataFetch(
  transport: Pick<McpSafeFetchOptions, "dispatch" | "lookupHostname"> = {}
): typeof fetch {
  return createMcpSafeFetch({
    ...transport,
    addressPolicy: async (address, url) => {
      metadataAddressPolicy ??= createPersonalMcpAddressPolicy({
        environment: () => buildPersonalMcpNetworkEnvironment(defaultPersonalMcpNetworkHost()),
        readLocalNetworkEnabled: async () => true
      });
      const denial = await metadataAddressPolicy.decide(address, url);
      if (denial) return denial;
      return url.protocol === "http:" && networkAddressScope(address.address) === "public" ? "mcp_http_address_forbidden" : null;
    },
    allowInsecureHttp: true,
    egressHeaders: PERSONAL_MCP_EGRESS_HEADERS,
    maxRedirects: 3
  });
}

/** One bounded, credential-free GET of an administrator's IdP metadata URL. */
export async function fetchSamlMetadata(
  url: string,
  input: { fetch?: typeof fetch; signal: AbortSignal }
): Promise<string> {
  if (!usableSamlUrl(url)) throw new SamlMetadataFetchError("metadata_unreachable");
  let response: Response;
  try {
    response = await (input.fetch ?? createSamlMetadataFetch())(url, {
      cache: "no-store",
      credentials: "omit",
      headers: {
        accept: "application/samlmetadata+xml, application/xml, text/xml",
        "accept-encoding": "identity",
        "user-agent": "AIQSA-SAML-Metadata"
      },
      method: "GET",
      redirect: "follow",
      signal: input.signal
    });
  } catch {
    throw new SamlMetadataFetchError("metadata_unreachable");
  }
  const encoding = response.headers.get("content-encoding");
  if (!response.ok || (encoding && encoding !== "identity")) {
    await response.body?.cancel().catch(() => undefined);
    throw new SamlMetadataFetchError(response.ok ? "metadata_invalid" : "metadata_unreachable");
  }
  try {
    // The shared bounded reader works on requests; this one only carries the response body.
    const body = new Request("https://saml-metadata.invalid/", {
      body: response.body,
      headers: response.headers,
      method: "POST",
      signal: input.signal,
      ...(response.body ? { duplex: "half" } : {})
    } as RequestInit);
    const bytes = await readBoundedRequestBody(body, { maxBytes: SAML_METADATA_XML_MAX_LENGTH, signal: input.signal });
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SamlMetadataFetchError(input.signal.aborted ? "metadata_unreachable" : "metadata_invalid");
  }
}
