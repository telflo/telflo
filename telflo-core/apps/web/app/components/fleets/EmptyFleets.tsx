import type { ReactNode } from "react";
import { Link } from "react-router";
import { Rocket } from "lucide-react";

/*
 * The fleet list's first-run card (D17a decision 23), shown when the
 * organization has no fleet at all ("All fleets" and nothing). As the D17a
 * Parity Notes say:
 * - the "editor" link opens `/app`, the configurations list;
 * - it says "group", never "deploy group", and "served", never "deployed"
 *   (decision 6: never "deployments").
 * A published version comes before installing (D17c-1 Preflight ruling 22;
 * Q28: a group's published version's collector version picks what an
 * install installs). The "New Fleet" button is the page's, passed in as
 * `action`.
 */

const STEPS: { title: string; detail: ReactNode }[] = [
  {
    title: "Build and publish a configuration",
    detail: (
      <>
        Create it in the{" "}
        <Link to="/app" className="text-brand hover:underline">
          editor
        </Link>{" "}
        and hit Publish — only published versions can be served.
      </>
    ),
  },
  {
    title: "Create a fleet and assign a published version",
    detail:
      "A fleet groups the collectors you manage together. Each group in a fleet ties a published version to its collectors; its collector version picks what to install.",
  },
  {
    title: "Install collectors and roll out changes",
    detail:
      "Install each collector with a copy-paste command; it shows up in the fleet's Collectors tab when it connects. Publish a new version and reassign — collectors pick it up on their next poll.",
  },
];

export function EmptyFleets({ action }: { action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-5 rounded-lg border border-dashed border-border px-6 py-12">
      <div className="flex flex-col items-center gap-2 text-center">
        <Rocket className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Create your first fleet</h2>
        <p className="text-[13px] text-muted-foreground">Manage every OpenTelemetry Collector you run from one place.</p>
      </div>

      <ol className="w-full max-w-md space-y-3">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex gap-3">
            <span className="mt-px font-mono text-xs tabular-nums text-muted-foreground">{index + 1}</span>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-foreground">{step.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>

      {action}
    </div>
  );
}
