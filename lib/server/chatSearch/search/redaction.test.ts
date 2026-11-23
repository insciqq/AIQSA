import { describe, expect, it } from "vitest";
import { SAVED_SECRET_MARKER } from "../../redaction/savedSecrets";
import { UNPROCESSED_TEXT_PLACEHOLDER } from "../../redaction/secrets";
import { pastChatSearchQuery, pastChatTitle, redactPastChatText } from "./redaction";

const URL_MARKER = "[REDACTED:CREDENTIAL_URL]";
const TOKEN_MARKER = "[REDACTED:TOKEN]";
const CREDENTIAL_URL = "https://deploy-bot:fixture-pass-42@db.example.org";
const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
const TOKEN_IN_VALUE = "API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456 DB_PASS=fixture-pass-42";

describe("past-chat query screening", () => {
  it("drops a credential URL whole when a saved value sits inside it", () => {
    expect(pastChatSearchQuery(CREDENTIAL_URL, ["deploy-bot"])).toBe("");
    expect(pastChatSearchQuery(CREDENTIAL_URL, [])).toBe("");
    expect(pastChatSearchQuery(`connect ${CREDENTIAL_URL} today`, ["deploy-bot"])).toBe("connect today");
  });

  it("drops a saved value whole when a recognized secret sits inside it", () => {
    expect(pastChatSearchQuery(`rotation ${TOKEN_IN_VALUE} schedule`, [TOKEN_IN_VALUE])).toBe("rotation schedule");
  });

  it("drops both together when they overlap in part, either way round", () => {
    expect(pastChatSearchQuery(`x corp-prefix::${GITHUB_TOKEN} y`, ["corp-prefix::ghp_abcdefghij"])).toBe("x y");
    expect(pastChatSearchQuery(`use ${CREDENTIAL_URL} lane-7 now`, ["db.example.org lane-7"])).toBe("use now");
  });

  it("matches a saved value whatever line endings the query and the value use", () => {
    expect(pastChatSearchQuery("rotation account=demo\npass=fixture-pass-42", ["account=demo\r\npass=fixture-pass-42"])).toBe("rotation");
    expect(pastChatSearchQuery("rotation account=demo\r\npass=fixture-pass-42", ["account=demo\npass=fixture-pass-42"])).toBe("rotation");
  });
});

describe("past-chat text and title screening", () => {
  it("removes a credential URL whole when a saved value sits inside it", () => {
    expect(redactPastChatText(`connect ${CREDENTIAL_URL} today`, ["deploy-bot"])).toBe(`connect ${URL_MARKER} today`);
    expect(pastChatTitle(`Deploy ${CREDENTIAL_URL}`, ["deploy-bot"])).toBe(`Deploy ${URL_MARKER}`);
  });

  it("removes a saved value whole when a recognized secret sits inside it", () => {
    expect(redactPastChatText(`rotation ${TOKEN_IN_VALUE} schedule`, [TOKEN_IN_VALUE]))
      .toBe(`rotation ${SAVED_SECRET_MARKER} schedule`);
  });

  it("removes both together when they overlap in part, either way round", () => {
    expect(redactPastChatText(`x corp-prefix::${GITHUB_TOKEN} y`, ["corp-prefix::ghp_abcdefghij"])).toBe(`x ${TOKEN_MARKER} y`);
    expect(redactPastChatText(`use ${CREDENTIAL_URL} lane-7 now`, ["db.example.org lane-7"])).toBe(`use ${URL_MARKER} now`);
  });

  it("matches a saved value whatever line endings are used, and shows LF line breaks", () => {
    expect(redactPastChatText("Login:\r\naccount=demo\r\npass=fixture-pass-42\r\nThanks", ["account=demo\npass=fixture-pass-42"]))
      .toBe(`Login:\n${SAVED_SECRET_MARKER}\nThanks`);
    expect(redactPastChatText(`Login:\r\n${CREDENTIAL_URL}`, ["deploy-bot"])).toBe(`Login:\n${URL_MARKER}`);
  });

  it("withholds text past the scan bound behind a marker", () => {
    const text = `${"word ".repeat(30_000)}tail ${GITHUB_TOKEN}`;
    const shown = redactPastChatText(text, []);
    expect(shown.endsWith(UNPROCESSED_TEXT_PLACEHOLDER)).toBe(true);
    expect(shown).not.toContain("tail");
    expect(shown.length).toBeLessThan(text.length);
  });
});
