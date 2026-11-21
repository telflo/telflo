/**
 * Copies text to the clipboard from a promise while keeping the click's user
 * activation: the install dialog's "Reveal &
 * copy command", whose text (the command with its bearer) arrives only after
 * the tokens' read and the reveal.
 *
 * Safari/WebKit allows a clipboard write only synchronously within the
 * activation of a click: a handler that awaits anything (a fetch, a reveal)
 * before writing has lost it, and `navigator.clipboard.writeText()` throws
 * `NotAllowedError`. Chrome and Firefox are lenient about that gap, which is
 * why the bug only shows in Safari.
 *
 * The Async Clipboard API takes a promise inside a `ClipboardItem`, so
 * `clipboard.write()` is called synchronously within the click and the text
 * resolves afterwards: WebKit keeps the activation for the pending write.
 * Firefox before 127 has no `ClipboardItem`; there it falls back to
 * `writeText` once the text is in, which works because those engines don't
 * enforce the synchronous rule.
 *
 * Call it synchronously in the event handler with a promise already
 * started: nothing may be awaited before the call, or Safari's activation is
 * lost. A promise that rejects (the dialog closed before the text was
 * built) writes nothing, and the returned promise rejects. The text is never
 * logged or put anywhere else.
 */
export function copyTextFromPromise(textPromise: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    return navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": textPromise.then((text) => new Blob([text], { type: "text/plain" })),
      }),
    ]);
  }
  return textPromise.then((text) => navigator.clipboard.writeText(text));
}
