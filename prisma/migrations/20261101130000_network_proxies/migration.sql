-- Personal and administrator proxies (operator decisions 2026-11-01, `agent_docs/SECURITY.md`, Proxies).
-- A new table only: no earlier release reads or writes it, so its writers stay safe during the upgrade.
-- A null owner is an administrator's proxy; deleting a user removes that user's own.
CREATE TABLE "NetworkProxy" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" VARCHAR(64) NOT NULL,
    "protocol" VARCHAR(16) NOT NULL,
    "host" VARCHAR(253) NOT NULL,
    "port" INTEGER NOT NULL,
    "login" VARCHAR(255),
    "passwordEnvelope" TEXT,
    "country" CHAR(2),
    "domainHints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckStatus" VARCHAR(64),
    "lastExitAddress" VARCHAR(45),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NetworkProxy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "NetworkProxy_name_check" CHECK (length("name") >= 1 AND btrim("name") = "name" AND "name" !~ '[[:cntrl:]]'),
    CONSTRAINT "NetworkProxy_protocol_check" CHECK ("protocol" IN ('http', 'https', 'socks5')),
    CONSTRAINT "NetworkProxy_port_check" CHECK ("port" BETWEEN 1 AND 65535),
    CONSTRAINT "NetworkProxy_password_login_check" CHECK ("passwordEnvelope" IS NULL OR "login" IS NOT NULL),
    CONSTRAINT "NetworkProxy_country_check" CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$'),
    CONSTRAINT "NetworkProxy_domainHints_check" CHECK ("domainHints" IS NOT NULL AND cardinality("domainHints") <= 50),
    CONSTRAINT "NetworkProxy_version_check" CHECK ("version" >= 1),
    CONSTRAINT "NetworkProxy_lastCheck_check" CHECK (("lastCheckedAt" IS NULL) = ("lastCheckStatus" IS NULL)),
    CONSTRAINT "NetworkProxy_lastExitAddress_check" CHECK ("lastExitAddress" IS NULL OR "lastCheckStatus" = 'ok')
);

CREATE INDEX "NetworkProxy_userId_createdAt_idx" ON "NetworkProxy"("userId", "createdAt");

-- A name selects a proxy in any case (`selectProxy`), so one owner cannot hold it twice.
CREATE UNIQUE INDEX "NetworkProxy_personal_name_key" ON "NetworkProxy"("userId", lower("name")) WHERE "userId" IS NOT NULL;
CREATE UNIQUE INDEX "NetworkProxy_administrator_name_key" ON "NetworkProxy"(lower("name")) WHERE "userId" IS NULL;

ALTER TABLE "NetworkProxy" ADD CONSTRAINT "NetworkProxy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
