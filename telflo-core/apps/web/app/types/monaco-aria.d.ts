// Monaco's screen-reader live region module (monaco-editor's
// esm/vs/base/browser/ui/aria/aria.js), which ships no declaration of its
// own. The editor tests import it to do what Monaco's StandaloneCodeEditor
// does with `ariaContainerElement`: the three functions it exports, as
// aria.js defines them.
declare module "monaco-editor/esm/vs/base/browser/ui/aria/aria.js" {
  /** Creates Monaco's live region (its alert and status nodes) and appends it to `parent`. */
  export function setARIAContainer(parent: HTMLElement): void;
  /** Announces `msg` through the live region's alert nodes. */
  export function alert(msg: string): void;
  /** Announces `msg` through the live region's polite status nodes. */
  export function status(msg: string): void;
}
