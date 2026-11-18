import { describe, expect, it } from "vitest";
import { createSendgridMailer } from "./sendgrid-mailer.js";

const message = {
  to: "ada@example.com",
  subject: "Confirm your Telflo email address",
  text: "Open https://app.telflo.io/verify-email?token=abc",
  html: '<a href="https://app.telflo.io/verify-email?token=abc">Confirm</a>',
};

function recordingFetch(response: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response;
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

function sentBody(init: RequestInit) {
  return JSON.parse(String(init.body));
}

describe("createSendgridMailer", () => {
  const settings = { apiKey: "SG.secret-key", from: "no-reply@telflo.io" };

  it("posts the message to SendGrid's v3 send endpoint, authenticated with the api key", async () => {
    const { calls, fetch } = recordingFetch(new Response(null, { status: 202 }));
    await createSendgridMailer(settings, { fetch }).send(message);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("Authorization")).toBe("Bearer SG.secret-key");
  });

  it("sends the configured sender, the recipient, and both bodies with plain text first", async () => {
    const { calls, fetch } = recordingFetch(new Response(null, { status: 202 }));
    await createSendgridMailer(settings, { fetch }).send(message);

    const body = sentBody(calls[0]!.init);
    expect(body.from).toEqual({ email: "no-reply@telflo.io" });
    expect(body.personalizations).toEqual([{ to: [{ email: "ada@example.com" }] }]);
    expect(body.subject).toBe(message.subject);
    expect(body.content).toEqual([
      { type: "text/plain", value: message.text },
      { type: "text/html", value: message.html },
    ]);
  });

  it("sends replyTo as SendGrid's reply_to", async () => {
    const { calls, fetch } = recordingFetch(new Response(null, { status: 202 }));
    await createSendgridMailer(settings, { fetch }).send({ ...message, replyTo: "grace@example.com" });

    expect(sentBody(calls[0]!.init).reply_to).toEqual({ email: "grace@example.com" });
  });

  it("sends no reply_to when the message has none", async () => {
    const { calls, fetch } = recordingFetch(new Response(null, { status: 202 }));
    await createSendgridMailer(settings, { fetch }).send(message);

    expect(sentBody(calls[0]!.init)).not.toHaveProperty("reply_to");
  });

  it("disables click tracking so token links are never rewritten through a third party", async () => {
    const { calls, fetch } = recordingFetch(new Response(null, { status: 202 }));
    await createSendgridMailer(settings, { fetch }).send(message);

    expect(sentBody(calls[0]!.init).tracking_settings.click_tracking).toEqual({
      enable: false,
      enable_text: false,
    });
  });

  it("throws with SendGrid's status and error body when the message is rejected", async () => {
    const { fetch } = recordingFetch(
      new Response('{"errors":[{"message":"The from address does not match a verified Sender Identity"}]}', {
        status: 403,
      }),
    );
    await expect(createSendgridMailer(settings, { fetch }).send(message)).rejects.toThrow(
      /HTTP 403: .*verified Sender Identity/,
    );
  });

  it("never puts the api key in the error it throws", async () => {
    const { fetch } = recordingFetch(new Response("unauthorized", { status: 401 }));
    const error = await createSendgridMailer(settings, { fetch })
      .send(message)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("SG.secret-key");
  });

  it("propagates a network failure rather than reporting the message as sent", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    await expect(createSendgridMailer(settings, { fetch }).send(message)).rejects.toThrow("fetch failed");
  });
});
