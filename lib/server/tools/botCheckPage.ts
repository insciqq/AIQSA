import type { FetchedPage } from "../webFetch/pageKinds";

/** A page with this much visible text or less, carrying a challenge phrase, is a challenge rather than an article about one. */
const SHORT_PAGE_CHARACTERS = 1_200;
/** A page with this much visible text or less has nothing to read, so a challenge widget in its markup is enough (a form with a CAPTCHA on a real page is not). */
const EMPTY_PAGE_CHARACTERS = 300;
const CHALLENGE_TEXT = new RegExp([
  "checking (?:your |the )?browser",
  "checking if the site connection is secure",
  "verif(?:y|ying) (?:that )?you(?: are|'re) (?:a )?human",
  "(?:confirm|prove) (?:that )?you(?: are|'re) (?:a )?human",
  "are you (?:a )?robot",
  "(?:confirm|verify) (?:that )?you(?: are|'re) not a robot",
  "проверка браузера",
  "проверяем (?:ваш )?браузер",
  "(?:вы|а) не робот",
  "(?:подтвердите|докажите),? что вы человек",
  "captcha",
  "капч[аеиу]"
].join("|"), "iu");
const CHALLENGE_WIDGET = /captcha|капча|challenge-form|challenge-running|challenge-stage/iu;

/**
 * Only a short page with a challenge phrase, or an all but empty one with a challenge widget, is a refusal; articles mentioning CAPTCHA
 * and real pages with a CAPTCHA on a form stay readable. The isolated parser supplies the text and title. Widget markers are a literal
 * scan of the already bounded HTML, never HTML parsing. No site is named here.
 */
export function isBotCheckPage(page: FetchedPage, body: Uint8Array): boolean {
  if ((page.kind !== "html" && page.kind !== "text") || page.truncated) return false;
  const text = page.text.replace(/\s+/gu, " ").trim();
  if (text.length > SHORT_PAGE_CHARACTERS) return false;
  return CHALLENGE_TEXT.test(`${page.title ?? ""} ${text}`) ||
    (page.kind === "html" && text.length <= EMPTY_PAGE_CHARACTERS && CHALLENGE_WIDGET.test(Buffer.from(body).toString("utf8")));
}

const PASSWORD_FIELD = /<input\b[^>]*\btype\s*=\s*["']?password\b/iu;
const SIGN_IN_PATH_SEGMENTS: ReadonlySet<string> = new Set(["auth", "authorize", "log-in", "login", "oauth", "oauth2", "saml", "saml2",
  "sign-in", "sign_in", "signin", "sso"]);
const SIGN_IN_HOST = /^(?:accounts|auth|id|idp|login|signin|sso)\./u;

/** Whether the page's final address is a sign-in form's: a sign-in host, or a path segment that names one. */
function signInAddress(finalUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(finalUrl);
  } catch {
    return false;
  }
  return SIGN_IN_HOST.test(url.hostname) ||
    url.pathname.split("/").some((segment) => SIGN_IN_PATH_SEGMENTS.has(segment.toLowerCase()));
}

/**
 * A short HTML page that asks for a password, or that a sign-in address served: what an internal tracker or wiki shows
 * an anonymous reader instead of the page (2026-11-20 audit). A long page with a login box stays an ordinary read.
 * Like `isBotCheckPage`, a literal scan of the already bounded HTML, and no site is named.
 */
export function isSignInPage(page: FetchedPage, body: Uint8Array, finalUrl: string): boolean {
  if (page.kind !== "html" || page.truncated) return false;
  if (page.text.replace(/\s+/gu, " ").trim().length > SHORT_PAGE_CHARACTERS) return false;
  return signInAddress(finalUrl) || PASSWORD_FIELD.test(Buffer.from(body).toString("utf8"));
}
