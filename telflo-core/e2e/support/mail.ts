import { developerEnv } from "./environment.js";

// Reads what the E2E API sent, from Mailpit's API. The API sends the email
// endpoints' mail after it has answered, so a test polls for its message
// rather than expecting it to be there already. Each test sends to its own
// address and searches by it, so nothing ever clears Mailpit.

const DEFAULT_MAILPIT_API_URL = "http://localhost:58025";
const WAIT_FOR_EMAIL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 250;

function mailpitApiUrl(): string {
  return developerEnv().TELFLO_MAILPIT_API_URL || DEFAULT_MAILPIT_API_URL;
}

interface MailpitSearchResult {
  messages: { ID: string; Subject: string }[];
}

interface MailpitMessage {
  Text: string;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Mailpit answered ${response.status} to GET ${url}`);
  return (await response.json()) as T;
}

function searchUrl(query: string): string {
  return `${mailpitApiUrl()}/api/v1/search?query=${encodeURIComponent(query)}`;
}

/**
 * The text of the newest message to `to` with exactly this subject, polled
 * for up to ten seconds, once there are at least `count` of them (default
 * one): a test that expects a second message, as a resend sends, passes 2.
 * Mailpit lists search results newest first. The subject goes into
 * Mailpit's search inside double quotes, so it must carry none.
 */
export async function waitForEmail({
  to,
  subject,
  count = 1,
}: {
  to: string;
  subject: string;
  count?: number;
}): Promise<string> {
  const url = searchUrl(`to:"${to}" subject:"${subject}"`);
  const deadline = Date.now() + WAIT_FOR_EMAIL_TIMEOUT_MS;

  for (;;) {
    const { messages } = await getJson<MailpitSearchResult>(url);
    const newest = messages[0];
    if (newest && messages.length >= count) {
      const message = await getJson<MailpitMessage>(`${mailpitApiUrl()}/api/v1/message/${newest.ID}`);
      return message.Text;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${messages.length} email(s) to ${to} with subject "${subject}" arrived in Mailpit within 10 s, not ${count}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** The subjects of every message to `to` that Mailpit holds now, newest first. */
export async function emailSubjectsTo(to: string): Promise<string[]> {
  const { messages } = await getJson<MailpitSearchResult>(searchUrl(`to:"${to}"`));
  return messages.map((message) => message.Subject);
}

/**
 * The first URL in `text` whose path is `path`, e.g. "/reset-password", as
 * written: its query or fragment included. A reset link carries its token in
 * the fragment, `#token=…`; a verify link, in the query.
 */
export function linkFrom(text: string, path: string): string {
  for (const candidate of text.match(/https?:\/\/\S+/g) ?? []) {
    if (new URL(candidate).pathname === path) return candidate;
  }
  throw new Error(`The email contains no link to ${path}:\n${text}`);
}
