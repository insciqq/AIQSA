import { describe, expect, it } from "vitest";
import { SAVED_SECRET_MARKER, savedSecretScreenedValues } from "../../redaction/savedSecrets";
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

  it("never folds a saved passphrase back together from whitespace the query splits it with", () => {
    const passphrase = "correct horse battery staple";
    for (const split of ["correct horse\nbattery staple", "correct  horse\tbattery\r\nstaple", "correct horse battery staple"]) {
      expect(pastChatSearchQuery(`find ${split}`, [passphrase])).toBe("find");
    }
    // A value saved with a line break matches the same words on one line.
    expect(pastChatSearchQuery(`find ${passphrase} now`, ["correct horse\nbattery staple"])).toBe("find now");
    // Words of the value alone, or in another order, are ordinary text.
    expect(pastChatSearchQuery("correct horse, battery", [passphrase])).toBe("correct horse, battery");
  });

  it("drops a token saved under a login name, and keeps an ordinary login searchable", () => {
    const sonarToken = `squ_${"0123456789abcdef".repeat(2)}01234567`;
    const saved = savedSecretScreenedValues([{ name: "Code quality", value: { entries: [
      { name: "SONAR_LOGIN", value: sonarToken }, { name: "SERVICE_LOGIN", value: "deploy-bot" },
      { name: "SONAR_HOST", value: "https://sonar.example.com" }
    ], kind: "env" } }]);
    expect(pastChatSearchQuery(`scanner login ${sonarToken} failed`, saved)).toBe("scanner login failed");
    expect(pastChatSearchQuery("deploy-bot on https://sonar.example.com", saved)).toBe("deploy-bot on https://sonar.example.com");
  });

  it("screens again once a dropped marker joins the words around it", () => {
    const passphrase = "correct horse battery staple";
    expect(pastChatSearchQuery(`find correct horse ${GITHUB_TOKEN} battery staple`, [passphrase])).toBe("find");
    expect(pastChatSearchQuery("find correct horse [REDACTED:TOKEN] battery staple", [passphrase])).toBe("find");
    expect(pastChatSearchQuery(`find ${GITHUB_TOKEN} today`, [passphrase])).toBe("find today");
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

  it("matches a saved value split by any whitespace, in shown text and in a title made one line", () => {
    const passphrase = "correct horse battery staple";
    expect(pastChatTitle("Vault correct horse\nbattery staple", [passphrase])).toBe(`Vault ${SAVED_SECRET_MARKER}`);
    expect(pastChatTitle("correct\thorse  battery\r\nstaple", [passphrase])).toBe(SAVED_SECRET_MARKER);
    expect(redactPastChatText("The phrase:\ncorrect horse\n\nbattery staple\nend", [passphrase]))
      .toBe(`The phrase:\n${SAVED_SECRET_MARKER}\nend`);
  });

  it("withholds text past the scan bound behind a marker", () => {
    const text = `${"word ".repeat(30_000)}tail ${GITHUB_TOKEN}`;
    const shown = redactPastChatText(text, []);
    expect(shown.endsWith(UNPROCESSED_TEXT_PLACEHOLDER)).toBe(true);
    expect(shown).not.toContain("tail");
    expect(shown.length).toBeLessThan(text.length);
  });
});
