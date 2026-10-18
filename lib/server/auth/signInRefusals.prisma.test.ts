// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../prisma";
import { createPrismaAdminRepository } from "./adminRepository";
import { completeExternalSignIn, externalIdentityPolicy } from "./externalIdentity";
import { createPrismaOAuthIdentityRepository } from "./oauthRepository";
import {
  deleteExpiredSignInRefusals,
  listSignInRefusals,
  recordSignInRefusal,
  SIGN_IN_REFUSAL_DAY_ROWS,
  type SignInRefusalInput
} from "./signInRefusals";
import { hashToken } from "./token";

type JournalFixture = Readonly<{
  /** A time on the test's own UTC day. */
  at(time: string): Date;
  day: Date;
  email(localPart: string): string;
  user(input: { localPart: string; status?: "active" | "disabled" }): Promise<{ email: string; id: string }>;
}>;

/**
 * Each test owns a synthetic UTC day long before any installation existed, so rows naming nobody
 * (keyed by day, method and code only) are its own, and a random email domain.
 */
async function withJournal<T>(isoDay: string, run: (fixture: JournalFixture) => Promise<T>): Promise<T> {
  const id = randomUUID();
  const domain = `refusals-${id}.example.com`;
  const day = new Date(`${isoDay}T00:00:00.000Z`);
  const clean = async () => {
    await prisma.signInRefusal.deleteMany({ where: { OR: [{ day }, { email: { endsWith: `@${domain}` } }] } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
  };
  await clean();
  try {
    return await run({
      at: (time) => new Date(`${isoDay}T${time}.000Z`),
      day,
      email: (localPart) => `${localPart}@${domain}`,
      async user(input) {
        const user = await prisma.user.create({
          data: { displayName: `Refused ${input.localPart}`, email: `${input.localPart}@${domain}`, status: input.status ?? "active" }
        });
        return { email: user.email!, id: user.id };
      }
    });
  } finally {
    await clean();
  }
}

const rowSelect = {
  attempts: true, code: true, email: true, firstSeenAt: true, lastSeenAt: true, method: true, subjectKey: true, userId: true
} as const;

function refusal(input: Partial<SignInRefusalInput> & Pick<SignInRefusalInput, "now" | "subject">): SignInRefusalInput {
  return { code: "not_allowed", method: "google", ...input };
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("refused sign-in journal", () => {
  it("counts a subject's refused attempts once per UTC day, method and code with its first and last time", async () => {
    await withJournal("2001-03-04", async ({ at, email }) => {
      const address = email("ana");
      await recordSignInRefusal(prisma, refusal({ method: "yandex", now: at("06:31:40"), subject: { email: address } }));
      // An earlier attempt written later still moves the first time back.
      await recordSignInRefusal(prisma, refusal({ method: "yandex", now: at("06:31:00"), subject: { email: address } }));
      await recordSignInRefusal(prisma, refusal({ method: "google", now: at("07:00:00"), subject: { email: address } }));
      await recordSignInRefusal(prisma, refusal({ code: "account_pending", method: "yandex", now: at("08:00:00"), subject: { email: address } }));
      await recordSignInRefusal(prisma, refusal({
        method: "yandex", now: new Date("2001-03-05T00:00:01.000Z"), subject: { email: address }
      }));

      const rows = await prisma.signInRefusal.findMany({
        orderBy: [{ day: "asc" }, { method: "asc" }, { code: "asc" }],
        select: { ...rowSelect, day: true },
        where: { email: address }
      });
      expect(rows.map((row) => [row.day.toISOString().slice(0, 10), row.method, row.code, row.attempts])).toEqual([
        ["2001-03-04", "google", "not_allowed", 1],
        ["2001-03-04", "yandex", "account_pending", 1],
        ["2001-03-04", "yandex", "not_allowed", 2],
        ["2001-03-05", "yandex", "not_allowed", 1]
      ]);
      expect(rows[2]).toMatchObject({
        email: address, firstSeenAt: at("06:31:00"), lastSeenAt: at("06:31:40"), subjectKey: `email:${address}`, userId: null
      });
    });
  });

  it("journals a refused Google callback with its verified email and counts the next one", async () => {
    await withJournal("2001-04-05", async ({ at, email }) => {
      const repository = createPrismaOAuthIdentityRepository(prisma);
      const address = email("stranger");
      const callback = {
        displayName: "Stranger", email: address, now: at("06:31:00"), provider: "google" as const,
        providerAccountId: `google-${randomUUID()}`
      };

      // No account and no sign-up rule for the address.
      await expect(repository.settleIdentity(callback)).resolves.toEqual({ status: "not_allowed" });
      await expect(repository.settleIdentity({ ...callback, now: at("06:32:00") })).resolves.toEqual({ status: "not_allowed" });

      await expect(prisma.signInRefusal.findMany({ select: rowSelect, where: { email: address } })).resolves.toEqual([{
        attempts: 2, code: "not_allowed", email: address, firstSeenAt: at("06:31:00"), lastSeenAt: at("06:32:00"),
        method: "google", subjectKey: `email:${address}`, userId: null
      }]);
      await expect(prisma.user.count({ where: { email: address } })).resolves.toBe(0);
    });
  });

  it("names an external refusal's email only when the source verified it or the method trusts it", async () => {
    await withJournal("2001-05-06", async ({ at, day, email }) => {
      const policy = externalIdentityPolicy({
        adminGroups: [], allowedGroups: [`allowed-${randomUUID()}`], autoCreateUsers: true, syncGroups: false
      });
      const signIn = (input: { email: string | null; emailVerified: boolean; trustUnverifiedEmail?: boolean }) =>
        completeExternalSignIn(prisma, {
          displayName: "Directory User",
          email: input.email,
          emailVerified: input.emailVerified,
          // Outside the allowed groups: refused before any account is read.
          groups: ["other"],
          now: at("09:00:00"),
          policy: { ...policy, trustUnverifiedEmail: input.trustUnverifiedEmail ?? false },
          provider: "oidc",
          session: { expiresAt: new Date("2001-05-07T00:00:00.000Z"), tokenHash: hashToken(randomUUID()) },
          signInMethod: "oidc",
          source: `https://idp-${randomUUID()}.example.test`,
          subject: `subject-${randomUUID()}`
        });

      await expect(signIn({ email: email("unverified"), emailVerified: false })).resolves.toEqual({ status: "not_allowed" });
      await expect(signIn({ email: email("verified"), emailVerified: true })).resolves.toEqual({ status: "not_allowed" });
      await expect(signIn({ email: email("trusted"), emailVerified: false, trustUnverifiedEmail: true }))
        .resolves.toEqual({ status: "not_allowed" });
      await expect(signIn({ email: null, emailVerified: true })).resolves.toEqual({ status: "email_missing" });

      const rows = await prisma.signInRefusal.findMany({
        orderBy: [{ code: "asc" }, { subjectKey: "asc" }], select: rowSelect, where: { day }
      });
      expect(rows.map((row) => [row.method, row.code, row.subjectKey, row.email, row.attempts])).toEqual([
        ["oidc", "email_missing", "no_verified_email", null, 1],
        ["oidc", "not_allowed", `email:${email("trusted")}`, email("trusted"), 1],
        ["oidc", "not_allowed", `email:${email("verified")}`, email("verified"), 1],
        ["oidc", "not_allowed", "no_verified_email", null, 1]
      ]);
      await expect(prisma.signInRefusal.count({ where: { email: email("unverified") } })).resolves.toBe(0);
    });
  });

  it("names a password refusal's account by id, and the row leaves with the account", async () => {
    await withJournal("2001-06-01", async ({ at, user }) => {
      const dana = await user({ localPart: "dana" });
      await recordSignInRefusal(prisma, refusal({
        code: "invalid_credentials", method: "password", now: at("10:00:00"), subject: { userId: dana.id }
      }));
      await recordSignInRefusal(prisma, refusal({
        code: "invalid_credentials", method: "password", now: at("10:01:00"), subject: { userId: dana.id }
      }));

      await expect(prisma.signInRefusal.findMany({ select: rowSelect, where: { userId: dana.id } })).resolves.toEqual([{
        attempts: 2, code: "invalid_credentials", email: null, firstSeenAt: at("10:00:00"), lastSeenAt: at("10:01:00"),
        method: "password", subjectKey: `user:${dana.id}`, userId: dana.id
      }]);

      await prisma.user.delete({ where: { id: dana.id } });
      await expect(prisma.signInRefusal.count({ where: { subjectKey: `user:${dana.id}` } })).resolves.toBe(0);
    });
  });

  it("drops a write that cannot land without failing the caller", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await withJournal("2001-06-02", async ({ at, day }) => {
      await expect(recordSignInRefusal(prisma, refusal({
        code: "invalid_credentials", method: "password", now: at("10:00:00"), subject: { userId: randomUUID() }
      }))).resolves.toBeUndefined();
      await expect(prisma.signInRefusal.count({ where: { day } })).resolves.toBe(0);
    });
  });

  it("counts concurrent attempts on one subject without losing any", async () => {
    await withJournal("2001-06-03", async ({ at, email }) => {
      const address = email("burst");
      await Promise.all(Array.from({ length: 8 }, (_, index) =>
        recordSignInRefusal(prisma, refusal({ now: at(`11:00:0${index}`), subject: { email: address } }))));

      await expect(prisma.signInRefusal.findMany({ select: { attempts: true }, where: { email: address } }))
        .resolves.toEqual([{ attempts: 8 }]);
    });
  });

  it("itemizes at most the day's limit of subjects and counts later ones on their method and code's overflow row", async () => {
    await withJournal("2001-06-07", async ({ at, day, email }) => {
      const first = email("first");
      await recordSignInRefusal(prisma, refusal({ now: at("00:00:01"), subject: { email: first } }));
      await prisma.signInRefusal.createMany({
        data: Array.from({ length: SIGN_IN_REFUSAL_DAY_ROWS - 1 }, (_, index) => {
          const filler = email(`filler-${index}`);
          return {
            code: "not_allowed", day, email: filler, firstSeenAt: at("00:00:02"), lastSeenAt: at("00:00:02"),
            method: "google" as const, subjectKey: `email:${filler}`
          };
        })
      });

      await recordSignInRefusal(prisma, refusal({ now: at("01:00:00"), subject: { email: email("late-1") } }));
      await recordSignInRefusal(prisma, refusal({ now: at("02:00:00"), subject: { email: email("late-2") } }));
      await recordSignInRefusal(prisma, refusal({ now: at("02:30:00"), subject: null }));
      await recordSignInRefusal(prisma, refusal({ code: "account_pending", method: "yandex", now: at("03:00:00"), subject: { email: email("late-3") } }));
      // A subject the day already itemizes keeps counting.
      await recordSignInRefusal(prisma, refusal({ now: at("04:00:00"), subject: { email: first } }));

      await expect(prisma.signInRefusal.count({ where: { day } })).resolves.toBe(SIGN_IN_REFUSAL_DAY_ROWS + 2);
      await expect(prisma.signInRefusal.findMany({
        orderBy: { method: "asc" }, select: rowSelect, where: { day, subjectKey: "overflow" }
      })).resolves.toEqual([
        { attempts: 3, code: "not_allowed", email: null, firstSeenAt: at("01:00:00"), lastSeenAt: at("02:30:00"),
          method: "google", subjectKey: "overflow", userId: null },
        { attempts: 1, code: "account_pending", email: null, firstSeenAt: at("03:00:00"), lastSeenAt: at("03:00:00"),
          method: "yandex", subjectKey: "overflow", userId: null }
      ]);
      await expect(prisma.signInRefusal.count({
        where: { email: { in: [email("late-1"), email("late-2"), email("late-3")] } }
      })).resolves.toBe(0);
      await expect(prisma.signInRefusal.findMany({ select: { attempts: true }, where: { email: first } }))
        .resolves.toEqual([{ attempts: 2 }]);
    });
  });

  it("prunes rows 30 days after their last attempt", async () => {
    await withJournal("2001-07-01", async ({ at, email }) => {
      await recordSignInRefusal(prisma, refusal({ now: at("10:00:00"), subject: { email: email("old") } }));
      await recordSignInRefusal(prisma, refusal({ now: at("10:00:02"), subject: { email: email("boundary") } }));
      await recordSignInRefusal(prisma, refusal({ now: new Date("2001-07-20T10:00:00.000Z"), subject: { email: email("fresh") } }));

      // Thirty days after 10:00:01: the 10:00:00 row is past retention, the 10:00:02 one is not yet.
      await expect(deleteExpiredSignInRefusals(prisma, new Date("2001-07-31T10:00:01.000Z"))).resolves.toBeGreaterThanOrEqual(1);

      await expect(prisma.signInRefusal.findMany({
        orderBy: { email: "asc" }, select: { email: true }, where: { email: { in: [email("old"), email("boundary"), email("fresh")] } }
      })).resolves.toEqual([{ email: email("boundary") }, { email: email("fresh") }]);
    });
  });

  it("lists the window's newest rows with the account an email belongs to now", async () => {
    await withJournal("2001-08-02", async ({ at, email, user }) => {
      const holder = await user({ localPart: "holder", status: "disabled" });
      const member = await user({ localPart: "member" });
      await recordSignInRefusal(prisma, refusal({ now: at("08:00:00"), subject: { email: holder.email } }));
      await recordSignInRefusal(prisma, refusal({ now: at("09:00:00"), subject: { email: email("stranger") } }));
      await recordSignInRefusal(prisma, refusal({
        code: "invalid_code", method: "ldap", now: at("10:00:00"), subject: { userId: member.id }
      }));
      await recordSignInRefusal(prisma, refusal({ now: new Date("2001-08-01T23:59:59.000Z"), subject: { email: email("before") } }));

      const { rows, total } = await listSignInRefusals(prisma, { from: at("00:00:00"), limit: 500 });
      const own = rows.filter((row) => row.email?.endsWith(holder.email.slice(holder.email.indexOf("@"))) ||
        row.userId === member.id);

      expect(total).toBeGreaterThanOrEqual(3);
      expect(own.map((row) => [row.subjectKey, row.code, row.account])).toEqual([
        [`user:${member.id}`, "invalid_code", { displayName: "Refused member", email: member.email, id: member.id, status: "active" }],
        [`email:${email("stranger")}`, "not_allowed", null],
        [`email:${holder.email}`, "not_allowed", { displayName: "Refused holder", email: holder.email, id: holder.id, status: "disabled" }]
      ]);
    });
  });

  it("removes the rows naming a deleted account's email along with the account's own rows", async () => {
    await withJournal("2001-09-03", async ({ at, email, user }) => {
      const gone = await user({ localPart: "gone", status: "disabled" });
      await recordSignInRefusal(prisma, refusal({ now: at("08:00:00"), subject: { email: gone.email } }));
      await recordSignInRefusal(prisma, refusal({
        code: "account_inactive", method: "password", now: at("08:30:00"), subject: { userId: gone.id }
      }));
      await recordSignInRefusal(prisma, refusal({ now: at("09:00:00"), subject: { email: email("other") } }));

      await expect(createPrismaAdminRepository(prisma).deleteStaleUser({ actingAdminUserId: randomUUID(), userId: gone.id }))
        .resolves.toBe("deleted");

      await expect(prisma.signInRefusal.count({
        where: { OR: [{ email: gone.email }, { subjectKey: `user:${gone.id}` }] }
      })).resolves.toBe(0);
      await expect(prisma.signInRefusal.count({ where: { email: email("other") } })).resolves.toBe(1);
    });
  });
});
