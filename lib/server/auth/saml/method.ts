import { SAML_NAME_ID_FORMATS } from "@/lib/contracts/samlSignIn";
import type { SignInMethodServerDefinition, SignInMethodTestResult } from "../signInSettings/registry";
import {
  inspectSamlCertificate,
  parseSamlIdpMetadata,
  sameSamlCertificate,
  samlMetadataFetchFailure,
  usableSamlUrl
} from "./metadata";
import { samlIdentitySource, type SamlSignInConfig } from "./config";

export type SamlMetadataFetcher = (url: string, input: { signal: AbortSignal }) => Promise<string>;

/** Loaded on first use, so the sign-in registry does not pull the network transport into every bundle. */
const fetchSamlMetadata: SamlMetadataFetcher = async (url, input) =>
  (await import("./metadataFetch")).fetchSamlMetadata(url, input);

function failed(code: string): SignInMethodTestResult {
  return { code, passed: false };
}

/**
 * Checks a SAML draft without a sign-in: a NameID or attribute that finds the account again,
 * a groups attribute when the policy needs groups, a usable SSO URL, pinned certificates that
 * can verify signatures, and, with a metadata URL, that the IdP still publishes this entity,
 * this SSO URL and at least one of these certificates.
 */
export function createSamlSignInMethod(deps: {
  fetchMetadata?: SamlMetadataFetcher;
  now?: () => Date;
} = {}): SignInMethodServerDefinition<"saml"> {
  const fetchMetadata = deps.fetchMetadata ?? fetchSamlMetadata;

  async function checkMetadata(config: SamlSignInConfig, signal: AbortSignal): Promise<SignInMethodTestResult | null> {
    if (!config.idpMetadataUrl) return null;
    let xml: string;
    try {
      xml = await fetchMetadata(config.idpMetadataUrl, { signal });
    } catch (error) {
      return failed(samlMetadataFetchFailure(error));
    }
    const metadata = parseSamlIdpMetadata(xml);
    if (!metadata) return failed("metadata_invalid");
    if (metadata.entityId !== config.idpEntityId) return failed("metadata_mismatch");
    if (!metadata.ssoUrls.includes(config.idpSsoUrl)) return failed("sso_url_invalid");
    const pinnedPublished = config.idpCertificates.some((pinned) =>
      metadata.certificates.some((published) => sameSamlCertificate(pinned, published)));
    return pinnedPublished ? null : failed("metadata_mismatch");
  }

  return {
    identitySource: samlIdentitySource,
    async test({ config, signal }) {
      if (!config.subjectAttribute && config.nameIdFormat === SAML_NAME_ID_FORMATS.transient) {
        return failed("nameid_transient");
      }
      if (!config.groupsAttribute && (config.allowedGroups.length || config.adminGroups.length || config.syncGroups)) {
        return failed("groups_attribute_required");
      }
      if (!usableSamlUrl(config.idpSsoUrl)) return failed("sso_url_invalid");
      const now = deps.now?.() ?? new Date();
      for (const certificate of config.idpCertificates) {
        const { problem } = inspectSamlCertificate(certificate, now);
        if (problem) return failed(problem);
      }
      return (await checkMetadata(config, signal)) ?? { code: "configuration_checked", passed: true };
    }
  };
}

export const samlSignInMethod = createSamlSignInMethod();
