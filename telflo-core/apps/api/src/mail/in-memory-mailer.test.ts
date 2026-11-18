import { describe, expect, it } from "vitest";
import { createInMemoryMailer } from "./in-memory-mailer.js";

describe("createInMemoryMailer", () => {
  it("records what it was asked to send", async () => {
    const mailer = createInMemoryMailer();
    await mailer.send({ to: "a@example.com", subject: "S", text: "T", html: "<p>T</p>" });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe("a@example.com");
  });

  it("records messages in the order they were sent", async () => {
    const mailer = createInMemoryMailer();
    await mailer.send({ to: "first@example.com", subject: "1", text: "1", html: "1" });
    await mailer.send({ to: "second@example.com", subject: "2", text: "2", html: "2" });
    expect(mailer.sent.map((m) => m.to)).toEqual(["first@example.com", "second@example.com"]);
  });

  it("records the reply-to address as it was given", async () => {
    const mailer = createInMemoryMailer();
    await mailer.send({ to: "a@example.com", replyTo: "b@example.com", subject: "S", text: "T", html: "T" });
    expect(mailer.sent[0]?.replyTo).toBe("b@example.com");
  });
});
