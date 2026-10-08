/** `getAuthConfig().clientIdentityMode`, as the admin panel shows it. */
export const CLIENT_IDENTITY_MODES = ["direct_loopback", "direct_peer", "invalid", "trusted_proxy"] as const;

export type ClientIdentityModeName = (typeof CLIENT_IDENTITY_MODES)[number];

export type TrustedHeaderPreset = Readonly<{
  emailHeader: string;
  groupsHeader: string | null;
  groupsSeparator: string;
  label: string;
  nameHeader: string | null;
}>;

/** Header sets of common authenticating proxies, offered as presets on the admin card. */
export const TRUSTED_HEADER_PRESETS: readonly TrustedHeaderPreset[] = [
  {
    emailHeader: "X-Auth-Request-Email",
    groupsHeader: "X-Auth-Request-Groups",
    groupsSeparator: ",",
    label: "oauth2-proxy",
    nameHeader: "X-Auth-Request-Preferred-Username"
  },
  {
    emailHeader: "Remote-Email",
    groupsHeader: "Remote-Groups",
    groupsSeparator: ",",
    label: "Authelia",
    nameHeader: "Remote-Name"
  },
  {
    emailHeader: "X-Authentik-Email",
    groupsHeader: "X-Authentik-Groups",
    groupsSeparator: "|",
    label: "Authentik",
    nameHeader: "X-Authentik-Name"
  },
  {
    emailHeader: "Cf-Access-Authenticated-User-Email",
    groupsHeader: null,
    groupsSeparator: ",",
    label: "Cloudflare Access",
    nameHeader: null
  }
];

/**
 * What the administrator's own request shows about trusted-header sign-in: the installation's
 * client identity mode and whether the request carries the email header, its value reduced to
 * the domain. Never persisted.
 */
export type AdminTrustedHeaderProbe = {
  clientIdentityMode: ClientIdentityModeName;
  /** Null when the request named no header to look for. */
  emailHeader: {
    /** `@example.com` for a usable value; null otherwise. */
    domainHint: string | null;
    present: boolean;
    /** A bounded, plausible email the sign-in would accept. */
    usable: boolean;
  } | null;
};

export type AdminTrustedHeaderProbeErrorCode = "forbidden" | "header_name_invalid" | "unauthorized";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isAdminTrustedHeaderProbe(value: unknown): value is AdminTrustedHeaderProbe {
  if (!isRecord(value) || !CLIENT_IDENTITY_MODES.some((mode) => mode === value.clientIdentityMode)) return false;
  const header = value.emailHeader;
  return header === null || (
    isRecord(header) && typeof header.present === "boolean" && typeof header.usable === "boolean" &&
    (header.domainHint === null || typeof header.domainHint === "string")
  );
}
