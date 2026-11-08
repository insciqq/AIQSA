import { Prisma } from "@prisma/client";
import { SMTP_CONTROL_ID } from "../email/repository";

/**
 * The one rule for "this account can receive automation emails", shared by
 * the editor's email switch (`readScheduledTaskEmailAvailability`) and the
 * result email's claim, so nobody can turn on an email that is never sent.
 * Installation SMTP is active, and the account is active with an address.
 *
 * The account's address is the one the installation trusts: only an email
 * the sign-in source verified, one the operator trusts for that method,
 * email proof (registration, invitation), the bootstrap or an
 * administrator-level writer (SCIM) sets it (`agent_docs/SIGN_IN.md`). A
 * verified sign-in identity is not required, since LDAP and SAML identities
 * carry the address their operator trusts without one.
 *
 * A SQL condition over the `User` row aliased `account`.
 */
export const SCHEDULED_TASK_EMAIL_RECIPIENT = Prisma.sql`(
  account."status" = 'active'::"UserStatus" AND NULLIF(btrim(account."email"), '') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "SmtpControl" AS smtp
    WHERE smtp."id" = ${SMTP_CONTROL_ID} AND smtp."enabled" AND smtp."activeConfig" IS NOT NULL)
)`;

/** Whether the account can receive automation emails now (`SCHEDULED_TASK_EMAIL_RECIPIENT`). */
export async function readScheduledTaskEmailRecipient(
  client: Pick<Prisma.TransactionClient, "$queryRaw">,
  userId: string
): Promise<boolean> {
  const [row] = await client.$queryRaw<Array<{ available: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "User" AS account WHERE account."id" = ${userId} AND ${SCHEDULED_TASK_EMAIL_RECIPIENT}
    ) AS "available"
  `);
  return row?.available === true;
}
