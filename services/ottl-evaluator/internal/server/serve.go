// After the opamp-server's serve: the serve and healthcheck subcommands.
// The HTTP server's general OPTIONS handler is off (newHTTPServer).

package server

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"time"
)

const (
	// shutdownTimeout lets requests in flight finish (an evaluation takes
	// at most its 5 s wait and 25 s limit) before the children still
	// running are killed.
	shutdownTimeout = 40 * time.Second
	// healthcheckTimeout bounds the healthcheck subcommand's request.
	healthcheckTimeout = 5 * time.Second
)

// Serve runs the server until ctx ends, and returns the process's exit code.
// It makes the process non-dumpable before reading the secret's file, and
// refuses to start without a valid secret or with a setting that doesn't
// parse.
func Serve(ctx context.Context, getenv func(string) string, environ []string, logger *slog.Logger) int {
	if err := makeNotDumpable(); err != nil {
		logger.Error("serve: the process couldn't be made non-dumpable", "error", err.Error())
		return 1
	}
	secrets, err := LoadSecrets(getenv, environ)
	if err != nil {
		logger.Error("serve: " + err.Error())
		return 1
	}
	settings, err := LoadSettings(getenv)
	if err != nil {
		logger.Error("serve: " + err.Error())
		return 1
	}
	base, stopChildren := context.WithCancel(context.Background())
	defer stopChildren()
	s, err := New(base, settings, secrets, logger, Options{})
	if err != nil {
		logger.Error("serve: " + err.Error())
		return 1
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(settings.Host, strconv.Itoa(settings.Port)))
	if err != nil {
		logger.Error("serve: can't listen", "port", settings.Port)
		return 1
	}
	srv := newHTTPServer(s.Handler())
	logger.Info("ottl-evaluator listening", "port", settings.Port, "ottlVersion", OTTLVersion(),
		"secrets", secrets.count(), "maxEvaluations", settings.MaxEvaluations, "maxValidations", settings.MaxValidations)

	served := make(chan error, 1)
	go func() { served <- srv.Serve(listener) }()
	select {
	case err := <-served:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("serve: the server stopped", "error", err.Error())
			return 1
		}
		return 0
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil {
		logger.Error("serve: shutting down took too long; stopping what is left")
	}
	stopChildren()
	_ = srv.Close()
	return 0
}

// newHTTPServer is serve's HTTP server around handler. Its general OPTIONS
// handler is off: Go's own answers `OPTIONS *` with 200 before any handler
// runs, so it would pass by the secret's check (and by the request's log
// line); with it off, `OPTIONS *` reaches the handler and is refused like
// any other request.
func newHTTPServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:                      handler,
		DisableGeneralOptionsHandler: true,
		ReadHeaderTimeout:            10 * time.Second,
		ReadTimeout:                  60 * time.Second,
		WriteTimeout:                 90 * time.Second,
		IdleTimeout:                  120 * time.Second,
		MaxHeaderBytes:               64 << 10,
	}
}

// Healthcheck asks the server on this host for its /health and returns 0 on
// a 200, 1 otherwise: the distroless image has no curl.
func Healthcheck(ctx context.Context, getenv func(string) string, logger *slog.Logger) int {
	settings, err := LoadSettings(getenv)
	if err != nil {
		logger.Error("healthcheck: " + err.Error())
		return 1
	}
	host := settings.Host
	if host == "" || net.ParseIP(host).IsUnspecified() {
		host = "127.0.0.1"
	}
	ctx, cancel := context.WithTimeout(ctx, healthcheckTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"http://"+net.JoinHostPort(host, strconv.Itoa(settings.Port))+healthPath, nil)
	if err != nil {
		return 1
	}
	client := &http.Client{Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	resp, err := client.Do(req)
	if err != nil {
		logger.Error("healthcheck: no answer")
		return 1
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		logger.Error("healthcheck: unhealthy", "status", resp.StatusCode)
		return 1
	}
	return 0
}
