import { NewFleetDialog, type NewFleetDialogProps } from "~/components/fleets/NewFleetDialog.js";

/**
 * "New server fleet", a Name and a Token expiry (Never, 180 days,
 * 1 year, 2 years; Never by default). The create itself, its retry and the
 * tokens shown once are `NewFleetDialog`'s.
 */
export function NewServerFleetDialog(props: NewFleetDialogProps) {
  return (
    <NewFleetDialog
      {...props}
      type="server"
      title="New server fleet"
      description="Name your fleet and choose how long its fleet token stays valid."
      withExpiry
    />
  );
}
