import {
  captureTestAuthEmail,
  clearTestAuthEmails,
  listTestAuthEmails
} from "./testMailer";

const email = {
  subject: "Verify",
  text: "private one-time link",
  to: "operator@example.com"
};

describe("test auth mailer", () => {
  beforeEach(() => {
    clearTestAuthEmails();
  });

  it("adapts the runtime dispatcher capture without exposing its internal message kind", async () => {
    captureTestAuthEmail({
      ...email,
      kind: "password_reset"
    });

    expect(listTestAuthEmails()).toEqual([email]);
  });
});
