import { ldapSignInMethod } from "../ldap/defaultLdapConnect";
import { oidcSignInMethod } from "../oidc/oidcMethod";
import { samlSignInMethod } from "../saml/method";
import { scimSignInMethod } from "../scim/signInMethod";
import { trustedHeaderSignInMethod } from "../trustedHeader/method";
import { googleSignInMethod, yandexSignInMethod } from "./oauthClientMethod";
import type { SignInMethodServerRegistry } from "./registry";

/**
 * Every sign-in method the admin panel can configure. A method task registers its definition
 * with one line here (`oidc: oidcSignInMethod,`) and its admin card with one line in
 * `components/admin/signIn/signInMethodCards.ts`.
 */
export const signInMethodServerRegistry: SignInMethodServerRegistry = {
  google: googleSignInMethod,
  ldap: ldapSignInMethod,
  oidc: oidcSignInMethod,
  saml: samlSignInMethod,
  scim: scimSignInMethod,
  trusted_header: trustedHeaderSignInMethod,
  yandex: yandexSignInMethod
};
