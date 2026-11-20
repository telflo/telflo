/*
 * The API's shutdown: without a signal handler, `docker stop` would wait
 * its 10 s and kill it, mid-request and mid-run. On SIGTERM or SIGINT,
 * index.ts closes the server (no new connections; the test runs' background
 * work stops in its onClose, the dispatcher finishing each run it aborts)
 * and then exits. Should closing hang, a hard exit follows after
 * SHUTDOWN_GRACE_MS, inside compose's 10 s; what that cuts short, the
 * reaper fails later.
 */

/** How long a shutdown may take before the process exits regardless. */
export const SHUTDOWN_GRACE_MS = 8_000;

/** The signals that shut the API down. */
export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

export interface ShutdownOptions {
  /** Closes the server, then whatever it leaves open (the pool). */
  close: () => Promise<void>;
  /** Ends the process: process.exit. */
  exit: (code: number) => void;
  log: {
    info(details: Record<string, unknown>, message: string): void;
    error(details: Record<string, unknown>, message: string): void;
  };
  /** Where the signals arrive: process. */
  signals: Pick<NodeJS.Process, "on">;
  /** SHUTDOWN_GRACE_MS by default. */
  graceMs?: number;
}

/**
 * Listens for SHUTDOWN_SIGNALS: the first closes and exits 0 (1 when closing
 * fails); a hard exit 1 follows after the grace period. Another signal
 * while shutting down, the same or the other, changes nothing.
 */
export function installShutdownHandlers(options: ShutdownOptions): void {
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
  let isShuttingDown = false;
  const shutDown = (signal: NodeJS.Signals): void => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    options.log.info({ signal }, "shutting down");
    const hardExit = setTimeout(() => {
      options.log.error({ signal, graceMs }, "shutting down took too long; exiting");
      options.exit(1);
    }, graceMs);
    hardExit.unref?.();
    options.close().then(
      () => {
        clearTimeout(hardExit);
        options.exit(0);
      },
      (error: unknown) => {
        clearTimeout(hardExit);
        options.log.error({ err: error }, "shutting down failed");
        options.exit(1);
      },
    );
  };
  // `on`, never `once`: a second signal while shutting down must find this
  // handler, or Node's default would end the process at once, before the
  // aborted runs are finished. The hard exit still bounds it.
  for (const signal of SHUTDOWN_SIGNALS) options.signals.on(signal, shutDown);
}
