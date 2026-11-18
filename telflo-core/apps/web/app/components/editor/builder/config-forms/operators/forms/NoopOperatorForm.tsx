/*
 * The `noop` operator's form (ADR 0018): text only. The operator has no keys
 * of its own (`transformer/noop/config.go`), so the form writes nothing.
 */
export function NoopOperatorForm() {
  return (
    <div className="space-y-4">
      <div className="px-3 py-2 bg-muted/50 rounded-md border border-border">
        <p className="text-sm font-medium text-foreground">No-Op Operator</p>
        <p className="text-xs text-muted-foreground mt-2">
          This operator passes log entries through without any modifications. It&apos;s useful as a terminal node in non-linear pipelines
          when using the Router operator.
        </p>
      </div>

      <div className="px-3 py-2 bg-muted/50 rounded-md border border-border">
        <p className="text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">Example use case:</strong> When using a Router operator with multiple routes, use
          noop as the output for routes that don&apos;t need additional processing.
        </p>
      </div>
    </div>
  );
}
