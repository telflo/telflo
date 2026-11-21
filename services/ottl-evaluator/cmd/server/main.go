// Dispatches subcommands, as the opamp-server's main does (lint-child is
// the public API's OTTL lint):
//
//	ottl-evaluator serve            the API (internal/server)
//	ottl-evaluator healthcheck      asks a running server's /health, for the
//	                                distroless image's health check
//	ottl-evaluator evaluate-child   one evaluation's work, run by serve
//	ottl-evaluator validate-child   one validation's work, run by serve
//	ottl-evaluator lint-child       one lint's work, run by serve
//	ottl-evaluator selfcheck        checks the container it runs in, from
//	                                the inside (distroless has no shell)
//
// Settings come from the environment (internal/server/settings.go and
// secrets.go); the children get none of it.
//
// main only dispatches: each subcommand takes its context, the environment
// and its streams, so tests run it in-process.
package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/telflo/ottl-evaluator/internal/rules"
	"github.com/telflo/ottl-evaluator/internal/server"
)

const usage = "usage: ottl-evaluator serve | healthcheck | evaluate-child | validate-child | lint-child | selfcheck"

// main stops serve gracefully on SIGTERM or SIGINT.
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	context.AfterFunc(ctx, stop)
	code := run(ctx, os.Args[1:], os.Getenv, os.Environ(), os.Stdin, os.Stdout)
	stop()
	os.Exit(code)
}

// run runs the subcommand args names and returns the exit code: 2 for a
// command line it doesn't understand. Log lines go to stdout as JSON; a
// child's stdout is its results, and it logs nothing.
func run(ctx context.Context, args []string, getenv func(string) string, environ []string, stdin io.Reader, stdout io.Writer) int {
	logger := slog.New(slog.NewJSONHandler(stdout, nil))
	if len(args) != 1 {
		logger.Error(usage)
		return 2
	}
	switch args[0] {
	case "serve":
		return server.Serve(ctx, getenv, environ, logger)
	case "healthcheck":
		return server.Healthcheck(ctx, getenv, logger)
	case server.EvaluateChildCommand:
		return rules.RunEvaluateChild(stdin, stdout, time.Now)
	case server.ValidateChildCommand:
		return rules.RunValidateChild(stdin, stdout)
	case server.LintChildCommand:
		return rules.RunLintChild(stdin, stdout)
	case server.SelfcheckCommand:
		return server.Selfcheck(ctx, getenv, environ, stdout)
	default:
		logger.Error(usage)
		return 2
	}
}
