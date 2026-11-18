import { Link } from "react-router";
import { Compass } from "lucide-react";
import { Button } from "~/components/ui/button.js";
import { useSignUpPath } from "~/lib/use-site.js";

const BUTTON_CLASS =
  "h-7 border-white/30 bg-transparent text-[13px] text-white hover:bg-white/10 hover:text-white";

/*
 * The playground's banner (ADR 0018; D31-1 decision 26), across the top of
 * the shell: its words, Take the tour (desktop only, when the tour is given:
 * D31-1's Task 6), Create free account (`/register`) and Sign in (`/login`).
 * Create free account only while registration is open (D36-1 decision 23,
 * Ruling 352): otherwise its target is sign-in, so Sign in alone stands for
 * both. A signed-in visitor sees the same buttons (decision 27).
 * `bg-blue-600` is the constant signal blue inside `tf-app` (it doesn't flip
 * with the theme), so the white text stays readable.
 */
export function PlaygroundBanner({ onTakeTour }: { onTakeTour?: (() => void) | undefined }) {
  const signUp = useSignUpPath();
  return (
    <div className="z-20 flex h-10 shrink-0 items-center justify-between gap-4 bg-blue-600 px-4">
      <p className="min-w-0 truncate text-[13px] text-white">
        <span className="font-medium">You&apos;re in the playground</span>
        {" — "}explore and edit freely, nothing here saves. Create a free account to build, test, and deploy for real.
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {onTakeTour !== undefined && (
          <Button size="sm" variant="outline" onClick={onTakeTour} className={`${BUTTON_CLASS} hidden md:inline-flex`}>
            <Compass className="h-3.5 w-3.5" />
            Take the tour
          </Button>
        )}
        {signUp === "/register" && (
          <Button asChild size="sm" variant="outline" className={BUTTON_CLASS}>
            <Link to={signUp}>Create free account</Link>
          </Button>
        )}
        <Button asChild size="sm" variant="outline" className={BUTTON_CLASS}>
          <Link to="/login">Sign in</Link>
        </Button>
      </div>
    </div>
  );
}
