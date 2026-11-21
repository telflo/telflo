import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/*
 * Settings › Account's first card: "Account", "Manage your account settings",
 * "Email" and "Your email address cannot be changed". The address is visible
 * text, not a disabled input: personal data stays visible text inside the
 * masked shell, never in an attribute, and an input's `value` is one.
 */
export function AccountCard() {
  const email = useCurrentUser()?.user.email ?? "";
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>Manage your account settings</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="space-y-2">
          <dt className="text-[13px] font-medium leading-none">Email</dt>
          <dd className="rounded-md border bg-muted px-2.5 py-1.5 font-mono text-xs break-all">{email}</dd>
          <dd className="text-xs text-muted-foreground">Your email address cannot be changed</dd>
        </dl>
      </CardContent>
    </Card>
  );
}
