import type { PrismaClient } from "@prisma/client";
import { expect, type Page } from "@playwright/test";
import { standEnv } from "./realIdp";

/**
 * Okta (Workforce Identity) helpers for the opt-in real-IdP specs: the management API with
 * AIQSA_E2E_OKTA_TOKEN, the sign-in widget, and the SAML app and password-only policy those
 * specs create. The token and the users' passwords are never printed.
 */

export type OktaPerson = Readonly<{ email: string; groups: readonly string[]; name: string; password: string }>;

/** Group names the specs create; group claims and statements filter on it. */
export const OKTA_PREFIX = "aiqsa-e2e-";

// Okta requires app visibility; the test apps stay off the users' dashboards.
export const OKTA_HIDDEN = { autoSubmitToolbar: false, hide: { iOS: true, web: true } };

export const oktaOrigin = () => new URL(standEnv("AIQSA_E2E_OKTA_ORG")).origin;

/** The Okta management API; failures name only the method, path, status and Okta's error code. */
export async function okta<T = Record<string, unknown>>(method: string, path: string, body?: unknown, accept = "application/json"): Promise<T> {
  const response = await fetch(`${oktaOrigin()}/api/v1${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { accept, authorization: `SSWS ${standEnv("AIQSA_E2E_OKTA_TOKEN")}`, "content-type": "application/json" },
    method
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { errorCauses?: Array<{ errorSummary?: string }>; errorCode?: string; errorSummary?: string };
    const summary = [detail.errorSummary, ...(detail.errorCauses ?? []).map((cause) => cause.errorSummary)].join(" ")
      .replace(/[^A-Za-z0-9 .,:_-]/gu, "").slice(0, 200);
    throw new Error(`okta ${method} ${path.split("?")[0]} -> ${response.status} ${detail.errorCode ?? ""} ${summary}`);
  }
  if (response.status === 204) return {} as T;
  return (accept === "application/json" ? await response.json() : await response.text()) as T;
}

/** Okta deletes a user or an app only once it is deactivated. */
export async function removeOkta(kind: "apps" | "users", id: string): Promise<void> {
  await okta("POST", `/${kind}/${id}/lifecycle/deactivate`).catch(() => undefined);
  await okta("DELETE", `/${kind}/${id}`).catch(() => undefined);
}

/** Creates the groups (by name) and activated password users; returns the ids for cleanup. */
export async function createOktaPeople(
  groupNames: readonly string[],
  people: readonly OktaPerson[],
  lastName: string
): Promise<{ groupIds: Map<string, string>; userIds: Map<string, string> }> {
  const groupIds = new Map<string, string>();
  const userIds = new Map<string, string>();
  for (const name of groupNames) {
    groupIds.set(name, (await okta<{ id: string }>("POST", "/groups", { profile: { description: "AIQSA e2e", name } })).id);
  }
  for (const person of people) {
    const user = await okta<{ id: string }>("POST", "/users?activate=true", {
      credentials: { password: { value: person.password } },
      groupIds: person.groups.map((name) => groupIds.get(name)!),
      profile: { email: person.email, firstName: person.name, lastName, login: person.email }
    });
    userIds.set(person.email, user.id);
  }
  return { groupIds, userIds };
}

/**
 * A custom SAML 2.0 app as an Okta administrator would create it from the recipe: persistent
 * NameID from the Okta username, `email` and a filtered `groups` statement, signed SHA-256.
 */
export async function createOktaSamlApp(label: string, acsUrl: string, spEntityId: string): Promise<string> {
  const unspecified = "urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified";
  const app = await okta<{ id: string }>("POST", "/apps", {
    label,
    settings: {
      signOn: {
        assertionSigned: true,
        attributeStatements: [
          { name: "email", namespace: unspecified, type: "EXPRESSION", values: ["user.email"] },
          { filterType: "REGEX", filterValue: `${OKTA_PREFIX}.*`, name: "groups", namespace: unspecified, type: "GROUP" }
        ],
        audience: spEntityId,
        authnContextClassRef: "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
        destination: acsUrl,
        digestAlgorithm: "SHA256",
        honorForceAuthn: true,
        idpIssuer: "http://www.okta.com/${org.externalKey}",
        recipient: acsUrl,
        requestCompressed: false,
        responseSigned: true,
        signatureAlgorithm: "RSA_SHA256",
        ssoAcsUrl: acsUrl,
        subjectNameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
        // Okta's default: the NameID is the app username (the Okta username unless the app overrides it).
        subjectNameIdTemplate: "${user.userName}"
      }
    },
    signOnMode: "SAML_2_0",
    visibility: OKTA_HIDDEN
  });
  return app.id;
}

/** New apps get the "Any two factors" policy; synthetic users have a password only. Returns the policy id. */
export async function assignPasswordOnlyPolicy(name: string, appIds: readonly string[]): Promise<string> {
  const policy = await okta<{ id: string }>("POST", "/policies", { name, type: "ACCESS_POLICY" });
  await okta("POST", `/policies/${policy.id}/rules`, {
    actions: { appSignOn: { access: "ALLOW", verificationMethod: { constraints: [{ knowledge: { types: ["password"] } }], factorMode: "1FA", reauthenticateIn: "PT2H", type: "ASSURANCE" } } },
    name: "Password only",
    type: "ACCESS_POLICY"
  });
  for (const appId of appIds) await okta("PUT", `/apps/${appId}/policies/${policy.id}`, {});
  return policy.id;
}

/**
 * Okta's sign-in widget (Identity Engine): identifier, then password, possibly an optional
 * authenticator enrollment to skip. Waits until the browser leaves Okta.
 */
export async function oktaSignIn(page: Page, person: OktaPerson): Promise<void> {
  const identifier = page.locator('input[name="identifier"]');
  const passcode = page.locator('input[name="credentials.passcode"]');
  const submit = page.locator('input[type="submit"], button[type="submit"]').first();
  const skip = page.getByRole("link", { name: /^(Skip|Set up later|Remind me later)$/u })
    .or(page.getByRole("button", { name: /^(Skip|Set up later|Remind me later)$/u }));
  const left = () => new URL(page.url()).origin !== oktaOrigin();
  const deadline = Date.now() + 90_000;
  let identified = false;
  let verified = false;
  while (!left()) {
    if (Date.now() > deadline) {
      const message = (await page.locator(".o-form-error-container, [role=alert]").allInnerTexts().catch(() => []))
        .join(" ").replace(/[^A-Za-z ]/gu, "").slice(0, 160);
      throw new Error(`okta_login_not_left path=${new URL(page.url()).pathname} identified=${identified} verified=${verified} error=${message || "-"}`);
    }
    if (!verified && await passcode.isVisible().catch(() => false)) {
      if (await identifier.isVisible().catch(() => false) && !identified) {
        await identifier.fill(person.email);
        identified = true;
      }
      await passcode.fill(person.password);
      await submit.click();
      verified = true;
    } else if (!identified && await identifier.isVisible().catch(() => false)) {
      await identifier.fill(person.email);
      await submit.click();
      identified = true;
    } else if (await skip.first().isVisible().catch(() => false)) {
      await skip.first().click();
    }
    await page.waitForTimeout(1_000);
  }
}

/** Content-free facts about the SAML response the browser posts to /saml/acs: no values, only shapes. */
export function watchSamlResponse(page: Page): () => string {
  let facts = "no_acs_post";
  page.on("request", (request) => {
    if (request.method() !== "POST" || !new URL(request.url()).pathname.endsWith("/saml/acs")) return;
    const encoded = new URLSearchParams(request.postData() ?? "").get("SAMLResponse") ?? "";
    const xml = Buffer.from(encoded, "base64").toString("utf8");
    const nameId = /<(?:[\w-]+:)?NameID\b([^>]*)>([^<]*)</u.exec(xml);
    const format = /Format="[^"]*:([A-Za-z-]+)"/u.exec(nameId?.[1] ?? "")?.[1] ?? "-";
    facts = [
      `nameId=${nameId ? "yes" : "no"}`,
      `format=${format}`,
      `length=${nameId?.[2]?.trim().length ?? 0}`,
      `encryptedId=${/EncryptedID\b/u.test(xml)}`,
      `encryptedAssertion=${/EncryptedAssertion\b/u.test(xml)}`,
      `assertions=${(xml.match(/<(?:[\w-]+:)?Assertion\b/gu) ?? []).length}`
    ].join(" ");
  });
  return () => facts;
}

/** The app shell after a sign-in; a refusal names the method's content-free failure code. */
export async function expectSignedIn(prisma: PrismaClient, page: Page, method: "oidc" | "saml", facts: () => string = () => "-"): Promise<void> {
  const shell = page.getByTestId("app-shell");
  await expect(shell.or(page.locator("[role=alert]:not(#__next-route-announcer__)"))).toBeVisible({ timeout: 60_000 });
  if (await shell.isVisible()) return;
  const health = await prisma.authSignInMethodSetting.findUnique({ select: { lastFailureCode: true }, where: { method } });
  throw new Error(`${method}_sign_in_refused url=${new URL(page.url()).search.replace(/[^a-z0-9=&_]/gu, "")} code=${health?.lastFailureCode ?? "-"} ${facts()}`);
}
