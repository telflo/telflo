import { Link } from "react-router";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.js";
import { Button } from "~/components/ui/button.js";
import { useSignUpPath } from "~/lib/use-site.js";

/** The dialog's title. */
export const SIGN_IN_TO_SAVE_TITLE = "Sign in to save";

/** The dialog's sentence: why to sign in, and how long the edit is kept. */
export const SIGN_IN_TO_SAVE_TEXT =
  "To save your configuration, sign in or create a free account. It's kept in this browser for 7 days until you do.";

/** Where Sign in goes: `/login`, then the configurations page, where the handoff dialog opens. */
export const SIGN_IN_TO_SAVE_LOGIN_PATH = "/login?redirectTo=%2Fapp";

/*
 * The sign-in-to-save dialog (D31-1 decision 4, Ruling 278): the
 * playground's Save, for a visitor who isn't signed in. The edit is already
 * staged (`useStagePlaygroundSave`); Sign in goes to `/login` with
 * `/app` as where to go after (the handoff dialog opens there), Create
 * free account to `/register`, Cancel closes it. While registration isn't
 * open (D36-1 decision 23, Ruling 352) there is no account to create: the
 * one way on is "Sign in to save", the same sign-in. Fixed words only.
 */
export function SignInToSaveDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const signUp = useSignUpPath();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader className="sm:text-center">
          <AlertDialogTitle>{SIGN_IN_TO_SAVE_TITLE}</AlertDialogTitle>
          <AlertDialogDescription>{SIGN_IN_TO_SAVE_TEXT}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:justify-center">
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {signUp === "/register" ? (
            <>
              <Button asChild variant="outline">
                <Link to={signUp}>Create free account</Link>
              </Button>
              <Button asChild>
                <Link to={SIGN_IN_TO_SAVE_LOGIN_PATH}>Sign in</Link>
              </Button>
            </>
          ) : (
            <Button asChild>
              <Link to={SIGN_IN_TO_SAVE_LOGIN_PATH}>Sign in to save</Link>
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
