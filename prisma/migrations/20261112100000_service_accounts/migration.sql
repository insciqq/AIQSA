-- Service accounts: a user kind that runs connector work (Discord Connect)
-- and can never sign in or be seen by SCIM. A service account is never an
-- administrator and has no email, so no email-based linking, invitation,
-- registration or password reset can reach it, and it never counts toward the
-- administrators that keep the installation manageable.
-- Expand only: every existing account, and every row a previous-release
-- writer inserts during the upgrade, takes the `person` default. Previous
-- releases never create service accounts, so the check holds for their rows.

-- CreateEnum
CREATE TYPE "UserKind" AS ENUM ('person', 'service');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "kind" "UserKind" NOT NULL DEFAULT 'person';

-- AddCheck
ALTER TABLE "User" ADD CONSTRAINT "User_service_account_check"
  CHECK ("kind" = 'person' OR ("role" = 'user' AND "email" IS NULL));
