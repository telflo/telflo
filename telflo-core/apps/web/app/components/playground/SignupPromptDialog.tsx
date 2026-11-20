import { Link } from "react-router";
import { Button } from "~/components/ui/button.js";
import { useSignUpPath } from "~/lib/use-site.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.js";

/** The prompt's title. */
export const SIGNUP_PROMPT_TITLE = "This is a sample workspace";

/** The prompt's sentence for an action: "To {action}, create a free account." */
export function signupPromptText(action: string | undefined): string {
  return `The playground is a sandbox with sample data — nothing here saves. To ${action ?? "do this for real"}, create a free account. It takes under a minute, no credit card required.`;
}

/*
 * `SignupPromptDialog`: the one sign-up prompt every locked action opens,
 * with its own action's words. The playground's provider holds the only one
 * (`useLockedAction` opens it). Keep exploring closes it; Create free account
 * goes to `/register`; Sign in to `/login`. While registration isn't open the
 * main button is Sign in, to `/login`, and the "Already have an account?"
 * line goes with the sign-up it answered. Its text is fixed words: an
 * action's words are the caller's constants, never a name or anything typed.
 */
export function SignupPromptDialog({
  open,
  onOpenChange,
  action,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the focus goes once the prompt has closed (Radix's `onCloseAutoFocus`): the provider gives it back to the opener. */
  onCloseAutoFocus?: ((event: Event) => void) | undefined;
  /** Completes the sentence "To …, create a free account." */
  action?: string | undefined;
}) {
  const signUp = useSignUpPath();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        {/* An informational prompt: centred, as message dialogs are. */}
        <DialogHeader className="sm:text-center">
          <DialogTitle>{SIGNUP_PROMPT_TITLE}</DialogTitle>
          <DialogDescription>{signupPromptText(action)}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-center">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep exploring
          </Button>
          <Button asChild>
            <Link to={signUp}>{signUp === "/register" ? "Create free account" : "Sign in"}</Link>
          </Button>
        </DialogFooter>
        {signUp === "/register" && (
          <p className="text-center text-xs text-muted-foreground">
            Already have an account?{" "}
            <Link to="/login" className="text-brand hover:underline">
              Sign in
            </Link>
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
