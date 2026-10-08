import { ldapSignInMethod } from "../ldap/defaultLdapConnect";
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
  yandex: yandexSignInMethod
};
