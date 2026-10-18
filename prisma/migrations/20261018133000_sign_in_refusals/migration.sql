-- Refused sign-ins for administrators: one row per UTC day, sign-in method,
-- refusal code and subject, counting the attempts between its first and last
-- time. The subject is an email the method verified (or is configured to
-- trust), the existing account a password or second-factor refusal resolved
-- to, or nobody; never a typed email, password, code, token, IdP payload or IP
-- address. The application prunes rows 30 days after their last attempt, and
-- deleting an account removes the rows that name it. Expand only:
-- previous-release writers never read or write the table.

-- CreateTable
CREATE TABLE "SignInRefusal" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "method" "AuthIdentityProvider" NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "subjectKey" VARCHAR(400) NOT NULL,
    "email" VARCHAR(320),
    "userId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignInRefusal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SignInRefusal_attempts_check" CHECK ("attempts" >= 1),
    CONSTRAINT "SignInRefusal_seen_check" CHECK ("firstSeenAt" <= "lastSeenAt"),
    -- The dedupe key names exactly the subject the row holds: an email, an
    -- account, or nobody (no verified email, or attempts past the day's limit).
    CONSTRAINT "SignInRefusal_subject_check" CHECK (
        ("email" IS NOT NULL AND "userId" IS NULL AND "subjectKey" = 'email:' || "email")
        OR ("userId" IS NOT NULL AND "email" IS NULL AND "subjectKey" = 'user:' || "userId")
        OR ("email" IS NULL AND "userId" IS NULL AND "subjectKey" IN ('no_verified_email', 'overflow'))
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "SignInRefusal_day_method_code_subjectKey_key" ON "SignInRefusal"("day", "method", "code", "subjectKey");

-- CreateIndex
CREATE INDEX "SignInRefusal_lastSeenAt_idx" ON "SignInRefusal"("lastSeenAt");

-- CreateIndex
CREATE INDEX "SignInRefusal_userId_idx" ON "SignInRefusal"("userId");

-- AddForeignKey: deleting an account removes the rows that name it.
ALTER TABLE "SignInRefusal" ADD CONSTRAINT "SignInRefusal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
