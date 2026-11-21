import { CheckboxField, NumberField, SelectField } from "./form-context.js";

/*
 * The debug exporter's form, over the form's fields: each field writes
 * its own key. The collector's defaults (debug exporter
 * `createDefaultConfig`, v0.162.0: basic, 2, 1, true) show while a key is
 * unset; 0 can be entered.
 */

const VERBOSITIES = [
  { value: "basic", label: "Basic" },
  { value: "normal", label: "Normal" },
  { value: "detailed", label: "Detailed" },
] as const;

export function DebugExporterForm() {
  return (
    <div className="space-y-4">
      <SelectField
        path={["verbosity"]}
        id="verbosity"
        label="Verbosity"
        defaultValue="basic"
        description="How much of each item is printed."
        options={VERBOSITIES}
      />

      <NumberField
        path={["sampling_initial"]}
        id="sampling-initial"
        label="Sampling Initial"
        defaultValue="2"
        description="Messages logged each second before sampling starts."
      />

      <NumberField
        path={["sampling_thereafter"]}
        id="sampling-thereafter"
        label="Sampling Thereafter"
        defaultValue="1"
        description="After that, log every Nth message."
      />

      <CheckboxField
        path={["use_internal_logger"]}
        id="use-internal-logger"
        label="Use Internal Logger"
        description="When off, prints directly to stdout."
        defaultChecked
      />
    </div>
  );
}
