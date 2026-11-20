import { TextField } from "./form-context.js";

/*
 * The zPages extension's form, over the form's fields. Changed: the default
 * shown is the collector's, `localhost:55679` (zpages `createDefaultConfig`,
 * core v0.162.0), not `0.0.0.0:55679`.
 */

export function ZPagesForm() {
  return (
    <div className="space-y-4">
      <TextField
        path={["endpoint"]}
        id="endpoint"
        label="Endpoint"
        defaultValue="localhost:55679"
        description="Address the zPages HTTP server listens on."
      />
    </div>
  );
}
