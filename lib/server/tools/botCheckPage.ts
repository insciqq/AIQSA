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
