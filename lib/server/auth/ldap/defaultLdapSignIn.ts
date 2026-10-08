import { prisma } from "../../prisma";
import { completeExternalSignIn } from "../externalIdentity";
import { resolveSignInMethods } from "../signInMethods";
import { recordSignInMethodOutcome } from "../signInSettings/defaultSignInSettings";
import { defaultLdapConnect } from "./defaultLdapConnect";
import { createLdapPasswordFormSignIn } from "./ldapSignIn";

/** LDAP on the login form, wired to the database and the active sign-in settings. */
export const ldapPasswordFormSignIn = createLdapPasswordFormSignIn({
  completeSignIn: (input) => completeExternalSignIn(prisma, input),
  connect: defaultLdapConnect,
  findUser: (userId) => prisma.user.findUnique({
    select: { displayName: true, email: true, id: true, role: true, status: true },
    where: { id: userId }
  }),
  recordOutcome: recordSignInMethodOutcome,
  resolveLdap: async () => (await resolveSignInMethods()).ldap ?? null
});
