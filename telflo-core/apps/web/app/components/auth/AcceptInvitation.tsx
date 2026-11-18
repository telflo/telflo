import { useEffect, useRef, useState } from "react";
import {
  INVITATION_ALREADY_ACCEPTED_MESSAGE,
  INVITATION_EXPIRED_MESSAGE,
  INVITATION_NOT_FOUND_MESSAGE,
  INVITATION_SIGN_IN_ONLY_MESSAGE,
  PASSWORD_MINIMUM_LENGTH,
  invitationEmailMismatchMessage,
  type CurrentUserResponse,
  type InvitationPreviewResponse,
  type JoinedOrganizationResponse,
  type OidcProvider,
} from "@telflo/contracts";
import { Link, useNavigate, useRevalidator } from "react-router";
import { Alert, AlertDescription } from "~/components/ui/alert.js";
import { Button } from "~/components/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.js";
import { Input } from "~/components/ui/input.js";
import { Label } from "~/components/ui/label.js";
import { postAcceptRedirectUrl } from "~/components/layout/org-welcome-tour.js";
import { organizationInSentence } from "~/lib/organization-names.js";
import { signedOutInThisBrowser } from "~/lib/signed-out.js";
import {
  ApiError,
  acceptInvitation,
  createSession,
  deleteCurrentSession,
  previewInvitation,
  registerFromInvitation,
} from "~/lib/api-client.js";
import { clearStoredToken, takeAddressBarToken } from "~/lib/address-bar-token.js";
import { useUserStore } from "~/lib/stores/user-store.js";
import { LOGOUT_FAILED_MESSAGE } from "~/lib/use-logout.js";
import {
  AuthDivider,
  FederatedSignInButtons,
  providersWithButtons,
  useRedirectingProvider,
} from "./FederatedSignIn.js";
import { describeSignInError } from "./LoginForm.js";
import { PasswordVisibilityToggle, TermsAgreement, type TermsToAccept } from "./RegisterForm.js";

const UNEXPECTED_ERROR_MESSAGE = "An unexpected error occurred. Please try again.";

/**
 * Where the page keeps the invitation link's token (D6 decision 2). The
 * emailed link carries it in its fragment, `/accept-invitation#token=…`,
 * which the browser never sends to a server. The page takes it out of the
 * address bar into `sessionStorage` (lib/address-bar-token.ts), so it
 * survives a sign-in or a round trip to Google in this tab and isn't left
 * in the history, and sends it only in the bodies of the three invitee
 * endpoints: not in a path or query, not in a log.
 */
export const INVITATION_TOKEN_STORAGE_KEY = "telflo.invitationToken";

/** The link's token: from the fragment, or kept from an earlier load in this tab. */
export function takeInvitationToken(): string | null {
  return takeAddressBarToken("fragment", INVITATION_TOKEN_STORAGE_KEY);
}

/**
 * Forgets the token: after it has been used to join, and when the preview
 * finds no invitation, or one that is expired or accepted (a resend issues a
 * new token, so this one can never work again).
 */
function clearInvitationToken(): void {
  clearStoredToken(INVITATION_TOKEN_STORAGE_KEY);
}

/** Where the Google button sends the visitor back to, for the token in `sessionStorage`. */
const ACCEPT_PAGE_PATH = "/accept-invitation";

/**
 * The refusals that say this token can never work again: a resend issues a
 * new one. The page forgets the token on any of them.
 */
const DEAD_TOKEN_CODES: ReadonlySet<string> = new Set([
  "invitation_not_found",
  "invitation_expired",
  "invitation_already_accepted",
]);

/**
 * Who is looking at the page, from its loader. `refresh_needed` comes only
 * from the server's render: the client loader refreshes it into one of the
 * other two before the page leaves "Processing your invitation..." (D6
 * Preflight ruling 3).
 */
export type InvitationVisitor =
  | { status: "signed_in"; currentUser: CurrentUserResponse }
  | { status: "refresh_needed" }
  | { status: "signed_out" };

type Invitation = InvitationPreviewResponse["invitation"];

type Preview =
  | { kind: "loading" }
  | { kind: "found"; invitation: Invitation }
  | { kind: "not_found" }
  | { kind: "failed"; message: string };

function messageOf(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : UNEXPECTED_ERROR_MESSAGE;
}

export interface AcceptInvitationProps {
  visitor: InvitationVisitor;
  /** The configured providers, from the page's loader; empty for none. */
  providers: readonly OidcProvider[];
  /** The site's Terms (lib/use-site.ts' termsToAccept), or null when it asks for none (D36-1 decision 32). */
  terms: TermsToAccept | null;
}

/*
 * The accept page (D6 decision 13; ADR 0018): one page for everyone, deciding
 * from the invitation's preview and whoever is signed in. The token is read
 * after hydration, since it is only in the browser (the fragment, then
 * `sessionStorage`): until then, and while the preview loads, the card says
 * "Processing your invitation...". A second link opened in the same tab
 * changes only the fragment, which loads nothing, so the page takes the token
 * again on every `hashchange`.
 *
 * Joining, by any path, goes to `/app?joined_org={id}`, where the signed-in
 * layout shows the welcome callout. There is no success alert, since the
 * page moves on at once.
 */
export function AcceptInvitation({ visitor, providers, terms }: AcceptInvitationProps) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  /** `undefined` until read; then the token, or null when there is none. */
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [preview, setPreview] = useState<Preview>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  /** The token as of the last link read, for a join that answers after a newer one arrived. */
  const currentToken = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const takeToken = () => {
      currentToken.current = takeInvitationToken();
      setToken(currentToken.current);
    };
    takeToken();
    window.addEventListener("hashchange", takeToken);
    return () => window.removeEventListener("hashchange", takeToken);
  }, []);

  useEffect(() => {
    // Whatever the last token's failure was, it isn't this one's.
    setError(null);
    if (!token) return;
    let isCurrent = true;
    setPreview({ kind: "loading" });
    previewInvitation({ token }).then(
      ({ invitation }) => {
        if (!isCurrent) return;
        // Expired and accepted are final for this token: a resend issues a
        // new one (D6 Ruling 15).
        if (invitation.status === "expired" || invitation.status === "accepted") clearInvitationToken();
        setPreview({ kind: "found", invitation });
      },
      (caught: unknown) => {
        if (!isCurrent) return;
        if (caught instanceof ApiError && caught.code === "invitation_not_found") {
          clearInvitationToken();
          setPreview({ kind: "not_found" });
        } else {
          setPreview({ kind: "failed", message: messageOf(caught) });
        }
      },
    );
    return () => {
      isCurrent = false;
    };
  }, [token]);

  /**
   * The last step of every path. The token is forgotten once it has been
   * used, or once the API says it never can be (a cancel, an expiry or an
   * acceptance since the preview). A failure is shown; one that says the
   * session is over loads the page again, which then shows it signed out.
   *
   * If a second link arrived while the request was out, its answer is about
   * the first: a refusal isn't shown on the new invitation's card, and the
   * new token isn't the one forgotten.
   */
  async function join(request: () => Promise<JoinedOrganizationResponse>): Promise<boolean> {
    const usedToken = currentToken.current;
    const isStale = () => currentToken.current !== usedToken;
    let joined: JoinedOrganizationResponse;
    try {
      joined = await request();
    } catch (caught) {
      if (isStale()) return false;
      setError(messageOf(caught));
      if (caught instanceof ApiError && DEAD_TOKEN_CODES.has(caught.code)) clearInvitationToken();
      if (caught instanceof ApiError && caught.code === "unauthenticated") void revalidator.revalidate();
      return false;
    }
    if (!isStale()) clearInvitationToken();
    void navigate(postAcceptRedirectUrl(joined.organization.id));
    return true;
  }

  if (token === undefined || visitor.status === "refresh_needed") return <ProcessingCard />;
  if (token === null) return <NoTokenCard />;

  switch (preview.kind) {
    case "loading":
      return <ProcessingCard />;
    case "not_found":
      return <UnusableLinkCard message={INVITATION_NOT_FOUND_MESSAGE} />;
    case "failed":
      return <UnusableLinkCard message={preview.message} />;
    case "found":
      break;
  }

  const { invitation } = preview;
  if (invitation.status === "expired") return <UnusableLinkCard message={INVITATION_EXPIRED_MESSAGE} />;
  if (invitation.status === "accepted") return <UnusableLinkCard message={INVITATION_ALREADY_ACCEPTED_MESSAGE} />;

  if (visitor.status === "signed_in") {
    const signedInEmail = visitor.currentUser.user.email;
    // Decision 3: only the invited address can accept, ignoring case.
    if (signedInEmail.toLowerCase() === invitation.email.toLowerCase()) {
      return (
        <JoinCard
          invitation={invitation}
          signedInEmail={signedInEmail}
          error={error}
          onAccept={() => join(() => acceptInvitation({ token }))}
        />
      );
    }
    return (
      <MismatchCard
        invitation={invitation}
        signedInEmail={signedInEmail}
        error={error}
        onSignOut={async () => {
          // Signed out on this page alone: the store is cleared, PostHog
          // forgets the user as a Logout does (D4 Ruling 14), and the page
          // loads again, now showing the form for the invited address.
          try {
            await deleteCurrentSession();
          } catch (caught) {
            // An ended session is signed out already.
            if (!(caught instanceof ApiError && caught.code === "unauthenticated")) {
              setError(LOGOUT_FAILED_MESSAGE);
              return;
            }
          }
          useUserStore.getState().clear();
          // PostHog reset, and the staged playground edit removed (Q211).
          signedOutInThisBrowser();
          setError(null);
          await revalidator.revalidate();
        }}
      />
    );
  }

  // An invitation that can't make an account here (D36-1 decisions 35 and
  // 52: invite-only and a personal organization's, or a closed site) offers
  // sign-in only, saying why, to an address with no account as to one with.
  if (invitation.hasAccount || !invitation.mayRegister) {
    return (
      <SignInAndJoinForm
        invitation={invitation}
        providers={providers}
        notice={invitation.hasAccount ? null : INVITATION_SIGN_IN_ONLY_MESSAGE}
        error={error}
        onError={setError}
        onSubmit={async (password) => {
          try {
            await createSession({ email: invitation.email, password });
          } catch (caught) {
            setError(describeSignInError(caught));
            return false;
          }
          const joined = await join(() => acceptInvitation({ token }));
          // Signed in, but not joined: the page loads again, signed in, with
          // the failure still shown and Accept to try again.
          if (!joined) void revalidator.revalidate();
          return joined;
        }}
      />
    );
  }

  return (
    <CreateAccountAndJoinForm
      invitation={invitation}
      providers={providers}
      terms={terms}
      error={error}
      onError={setError}
      onSubmit={(password) =>
        join(() =>
          registerFromInvitation({ token, password, ...(terms !== null && { acceptedTermsVersion: terms.version }) }),
        )
      }
    />
  );
}

/** The loading card. */
function ProcessingCard() {
  return (
    <Card className="mx-auto w-full max-w-md">
      <CardContent className="py-12">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-5 w-5 border-2 border-muted-foreground/25 border-t-muted-foreground" />
          <p className="text-sm text-muted-foreground">Processing your invitation...</p>
        </div>
      </CardContent>
    </Card>
  );
}

/** The card for a link without its token: the alert alone, with its invalid-link text. */
function NoTokenCard() {
  return (
    <Card className="mx-auto w-full max-w-md">
      <CardContent className="py-8">
        <Alert variant="destructive">
          <AlertDescription>{INVITATION_NOT_FOUND_MESSAGE}</AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

/** The error card, for a link that can't be used, with the way into the app. */
function UnusableLinkCard({ message }: { message: string }) {
  return (
    <Card className="mx-auto w-full max-w-md">
      <CardContent className="space-y-4 py-8">
        <Alert variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
        <Button asChild className="w-full">
          <Link to="/app">Go to Telflo</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function ErrorAlert({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

/**
 * The organization as the cards' titles name it: a personal workspace named
 * by its owner's email reads "<email>'s organization", any other name is
 * itself (D36-1 Q264, the invite dialog's rule). Visible text, as the name
 * always was here.
 */
function invitedOrganization(invitation: Invitation): string {
  return organizationInSentence(invitation.organizationName, invitation.organizationType);
}

/** Who the page sees signed in. */
function SignedInAs({ email }: { email: string }) {
  return (
    <p className="text-sm text-muted-foreground">
      Signed in as <span className="font-medium text-foreground">{email}</span>
    </p>
  );
}

/** The invited address, shown and fixed: only it can accept (decision 3). */
function InvitedEmailField({ email }: { email: string }) {
  return (
    <div className="space-y-2">
      <Label htmlFor="email">Email</Label>
      <Input id="email" name="email" type="email" autoComplete="username" value={email} readOnly />
    </div>
  );
}

function JoinCard({
  invitation,
  signedInEmail,
  error,
  onAccept,
}: {
  invitation: Invitation;
  signedInEmail: string;
  error: string | null;
  onAccept: () => Promise<boolean>;
}) {
  const [isAccepting, setIsAccepting] = useState(false);

  async function handleAccept() {
    if (isAccepting) return; // Guards the double-click that would accept twice.
    setIsAccepting(true);
    // On success the button stays disabled until the navigation unmounts it.
    if (!(await onAccept())) setIsAccepting(false);
  }

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>Join {invitedOrganization(invitation)}</CardTitle>
        <CardDescription>You&apos;ve been invited with the {invitation.role} role.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ErrorAlert error={error} />
        <SignedInAs email={signedInEmail} />
      </CardContent>
      <CardFooter>
        <Button type="button" className="w-full" onClick={() => void handleAccept()} disabled={isAccepting}>
          {isAccepting ? "Accepting..." : "Accept Invitation"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function MismatchCard({
  invitation,
  signedInEmail,
  error,
  onSignOut,
}: {
  invitation: Invitation;
  signedInEmail: string;
  error: string | null;
  onSignOut: () => Promise<void>;
}) {
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await onSignOut();
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>Join {invitedOrganization(invitation)}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant="destructive">
          <AlertDescription>{invitationEmailMismatchMessage(invitation.email)}</AlertDescription>
        </Alert>
        <ErrorAlert error={error} />
        <SignedInAs email={signedInEmail} />
      </CardContent>
      <CardFooter>
        <Button
          type="button" variant="outline" className="w-full"
          onClick={() => void handleSignOut()} disabled={isSigningOut}
        >
          {isSigningOut ? "Signing out..." : "Sign out"}
        </Button>
      </CardFooter>
    </Card>
  );
}

/**
 * The existing-user form, for the invited address: its password,
 * then acceptance. "Forgot password?" stays in view, for an account whose
 * email was never confirmed ("Email not confirmed"): a reset confirms it
 * (D6 Preflight minor). The Google button comes back here.
 */
function SignInAndJoinForm({
  invitation,
  providers,
  notice,
  error,
  onError,
  onSubmit,
}: {
  invitation: Invitation;
  providers: readonly OidcProvider[];
  /** Why only sign-in is offered, when it is (D36-1 decision 52); null otherwise. */
  notice: string | null;
  error: string | null;
  onError: (error: string | null) => void;
  onSubmit: (password: string) => Promise<boolean>;
}) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [redirectingId, setRedirectingId] = useRedirectingProvider();
  const isBusy = isSubmitting || redirectingId !== null;
  const providerIds = providersWithButtons(providers);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) return; // Guards the double-click that would sign in twice.
    onError(null);
    setIsSubmitting(true);
    // On success the form stays disabled until the navigation unmounts it.
    if (!(await onSubmit(password))) setIsSubmitting(false);
  }

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>Sign in to join {invitedOrganization(invitation)}</CardTitle>
        <CardDescription>Sign in to your account to join your organization</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          {notice !== null && (
            <Alert>
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}
          <ErrorAlert error={error} />

          {providerIds.length > 0 && (
            <>
              <FederatedSignInButtons
                providerIds={providerIds}
                redirectTo={ACCEPT_PAGE_PATH}
                isDisabled={isBusy}
                redirectingId={redirectingId}
                onRedirect={setRedirectingId}
              />
              <AuthDivider>or continue with email</AuthDivider>
            </>
          )}

          <InvitedEmailField email={invitation.email} />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link to="/forgot-password" className="text-sm text-brand hover:underline">
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <Input
                id="password" name="password" type={showPassword ? "text" : "password"}
                autoComplete="current-password" required placeholder="••••••••" className="pr-10"
                value={password} onChange={(e) => setPassword(e.target.value)} disabled={isBusy}
              />
              <PasswordVisibilityToggle isVisible={showPassword} onToggle={() => setShowPassword(!showPassword)} />
            </div>
          </div>
        </CardContent>

        <CardFooter>
          <Button type="submit" className="w-full" disabled={isBusy}>
            {isSubmitting ? "Signing in..." : "Sign In & Join"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * The new-user form, as registration at the invited address: its
 * password rule and terms checkbox (D6 decision 9; none on a site that asks
 * for no Terms, D36-1 decision 32). The account is verified,
 * since the link proved the mailbox, so it joins signed in.
 */
function CreateAccountAndJoinForm({
  invitation,
  providers,
  terms,
  error,
  onError,
  onSubmit,
}: {
  invitation: Invitation;
  providers: readonly OidcProvider[];
  terms: TermsToAccept | null;
  error: string | null;
  onError: (error: string | null) => void;
  onSubmit: (password: string) => Promise<boolean>;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [hasAcceptedTerms, setHasAcceptedTerms] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [redirectingId, setRedirectingId] = useRedirectingProvider();
  const isBusy = isSubmitting || redirectingId !== null;
  const providerIds = providersWithButtons(providers);

  /** The match, then the length, then the terms; the server checks the same. */
  function findValidationError(): string | null {
    if (password !== confirmPassword) return "Passwords do not match";
    if (password.length < PASSWORD_MINIMUM_LENGTH) {
      return `Password must be at least ${PASSWORD_MINIMUM_LENGTH} characters`;
    }
    if (terms !== null && !hasAcceptedTerms) return "You must accept the terms to continue.";
    return null;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isBusy) return; // Guards the double-click that would register twice.
    onError(null);

    const validationError = findValidationError();
    if (validationError) {
      onError(validationError);
      return;
    }

    setIsSubmitting(true);
    // On success the form stays disabled until the navigation unmounts it.
    if (!(await onSubmit(password))) setIsSubmitting(false);
  }

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>Join {invitedOrganization(invitation)} on Telflo</CardTitle>
        <CardDescription>Set up your account to join your organization</CardDescription>
      </CardHeader>
      {/* noValidate, as on RegisterForm: the page's messages, in its order. */}
      <form onSubmit={handleSubmit} noValidate>
        <CardContent className="space-y-4">
          <ErrorAlert error={error} />

          {providerIds.length > 0 && (
            <>
              <FederatedSignInButtons
                providerIds={providerIds}
                redirectTo={ACCEPT_PAGE_PATH}
                isDisabled={isBusy}
                redirectingId={redirectingId}
                onRedirect={setRedirectingId}
              />
              <AuthDivider>or set a password</AuthDivider>
            </>
          )}

          <InvitedEmailField email={invitation.email} />

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password" name="password" type={showPassword ? "text" : "password"}
                autoComplete="new-password" required placeholder="••••••••" className="pr-10"
                value={password} onChange={(e) => setPassword(e.target.value)} disabled={isBusy}
              />
              <PasswordVisibilityToggle isVisible={showPassword} onToggle={() => setShowPassword(!showPassword)} />
            </div>
            <p className="text-xs text-muted-foreground">Minimum {PASSWORD_MINIMUM_LENGTH} characters.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm Password</Label>
            <div className="relative">
              <Input
                id="confirmPassword" name="confirmPassword"
                type={showConfirmPassword ? "text" : "password"}
                autoComplete="new-password" required placeholder="••••••••" className="pr-10"
                value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={isBusy}
              />
              <PasswordVisibilityToggle
                isVisible={showConfirmPassword}
                onToggle={() => setShowConfirmPassword(!showConfirmPassword)}
              />
            </div>
          </div>

          {/* No Terms on a site that asks for none (D36-1 decision 32). */}
          {terms !== null && (
            <>
              <AuthDivider>Usage policies</AuthDivider>

              <TermsAgreement terms={terms} checked={hasAcceptedTerms} onCheckedChange={setHasAcceptedTerms} disabled={isBusy} />
            </>
          )}
        </CardContent>

        <CardFooter>
          <Button type="submit" className="w-full" disabled={isBusy}>
            {isSubmitting ? "Creating account..." : "Create Account & Join"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
