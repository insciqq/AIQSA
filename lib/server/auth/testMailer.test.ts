import {
  clearTestAuthEmails,
  createTestEmailCapture,
  createTestAuthMailer,
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

  it("stores messages in one local process buffer and clears them", async () => {
    const mailer = createTestAuthMailer();

    await mailer.send(email);
    await mailer.send({ ...email, to: "other@example.com" });

    expect(listTestAuthEmails()).toEqual([email, { ...email, to: "other@example.com" }]);
    clearTestAuthEmails();
    expect(listTestAuthEmails()).toEqual([]);
  });

  it("adapts the runtime dispatcher capture without exposing its internal message kind", async () => {
    await createTestEmailCapture().capture({
      ...email,
      kind: "password_reset"
    });

    expect(listTestAuthEmails()).toEqual([email]);
  });
});
