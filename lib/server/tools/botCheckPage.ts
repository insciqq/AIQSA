import type { FetchedPage } from "../webFetch/pageKinds";

const SHORT_PAGE_CHARACTERS = 1_200;
const CHALLENGE_TEXT = /checking (?:your )?browser|verify (?:that )?you are (?:a )?human|are you (?:a )?robot|(?:confirm|verify) (?:that )?you are not a robot|проверка браузера|вы не робот|captcha|капча/iu;
const CHALLENGE_WIDGET = /captcha|капча|challenge-form|challenge-running|challenge-stage/iu;

/**
 * Only a short page with challenge markers is a refusal; articles mentioning CAPTCHA stay readable. The isolated
 * parser supplies the text and title. Widget markers are a literal scan of the already bounded HTML, never HTML parsing.
 */
export function isBotCheckPage(page: FetchedPage, body: Uint8Array): boolean {
  if ((page.kind !== "html" && page.kind !== "text") || page.truncated) return false;
  const text = page.text.replace(/\s+/gu, " ").trim();
  if (text.length > SHORT_PAGE_CHARACTERS) return false;
  return CHALLENGE_TEXT.test(`${page.title ?? ""} ${text}`) ||
    (page.kind === "html" && CHALLENGE_WIDGET.test(Buffer.from(body).toString("utf8")));
}
