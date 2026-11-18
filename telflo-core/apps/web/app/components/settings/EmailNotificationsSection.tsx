import { DEFAULT_USER_PREFERENCES } from "@telflo/contracts";
import { useId } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card.js";
import { Label } from "~/components/ui/label.js";
import { Switch } from "~/components/ui/switch.js";
import { useSavePreference } from "~/lib/preferences.js";
import { useCurrentUser } from "~/lib/use-current-user.js";

/*
 * Settings › Notifications (ADR 0018; D21 decisions 13 and 32): the two
 * switches are `preferences.email` (`productUpdates`, `productTips`), read
 * from `/me` through the user store, so there is no load of their own.
 * Nothing reads them yet: they wait for a future sender (D35). Each switch
 * saves its own key, optimistically (decision 33); a failure restores it and
 * toasts "Failed to update email preferences".
 */

export function EmailNotificationsSection() {
  const email = useCurrentUser()?.preferences.email ?? DEFAULT_USER_PREFERENCES.email;
  const save = useSavePreference();
  const id = useId();
  const productUpdatesId = `${id}-product-updates`;
  const productTipsId = `${id}-product-tips`;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Email Notifications</CardTitle>
          <CardDescription>Choose which emails you&apos;d like to receive from Telflo</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Product Updates */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor={productUpdatesId}>Product updates</Label>
              <p id={`${productUpdatesId}-description`} className="text-[13px] text-muted-foreground">
                New features, improvements, and fixes when we release a new version
              </p>
            </div>
            <Switch
              id={productUpdatesId}
              aria-describedby={`${productUpdatesId}-description`}
              checked={email.productUpdates}
              onCheckedChange={(checked) => void save("email.productUpdates", checked)}
            />
          </div>

          {/* Product Tips */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor={productTipsId}>Product tips</Label>
              <p id={`${productTipsId}-description`} className="text-[13px] text-muted-foreground">
                Helpful tips and reminders to get the most out of Telflo
              </p>
            </div>
            <Switch
              id={productTipsId}
              aria-describedby={`${productTipsId}-description`}
              checked={email.productTips}
              onCheckedChange={(checked) => void save("email.productTips", checked)}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
