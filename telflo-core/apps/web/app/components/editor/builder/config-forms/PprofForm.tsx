import { TextField } from "./form-context.js";

/*
 * The pprof extension's form, over the form's fields. The default shown is
 * the collector's, `localhost:1777` (pprof `createDefaultConfig`, contrib
 * v0.162.0).
 */

export function PprofForm() {
  return (
    <div className="space-y-4">
      <TextField
        path={["endpoint"]}
        id="endpoint"
        label="Endpoint"
        defaultValue="localhost:1777"
        description="Address the pprof HTTP server listens on."
      />
    </div>
  );
}
