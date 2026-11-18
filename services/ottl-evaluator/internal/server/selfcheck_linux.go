// New in D15a Task 3 (plan Preflight ruling 13; the ledger's A4e): the
// selfcheck subcommand's checks, which read /proc. Run in the container
// (scripts/check-container.sh), next to the serve process that is its PID 1.
// D15a Task 3's follow-up (the controller's Ruling 34) adds the network's
// positive control: the evaluator's own service name resolves to it, and
// serve answers there.

//go:build linux

package server

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// Selfcheck checks the container it runs in, printing one line per check,
// and returns 1 when any fails:
//
//   - it runs as uid and gid 65532;
//   - this process and PID 1 (serve) hold no capability in any set and have
//     no-new-privileges; PID 1 is serve, as uid 65532;
//   - / is mounted read-only, and writing to /, /app and /tmp fails with
//     EROFS;
//   - the network works inside: the evaluator's own compose service name
//     (ottl-evaluator) resolves through Docker's DNS to this
//     container, and serve answers on it;
//   - no route out: 1.1.1.1:443 and 8.8.8.8:53 don't answer and example.com
//     doesn't resolve, each attempt bounded (they pass by failing within
//     selfcheckDialTimeout; the control above shows why they fail);
//   - no secret's text in its environment: no OTTL_EVALUATOR_SECRET* variable
//     but the two naming files, and the secret's file's text in no variable;
//   - PID 1's environ is refused (serve made itself non-dumpable);
//   - made non-dumpable as serve is, it starts an evaluate child as serve
//     does, which raises its own oom_score_adj and answers.
func Selfcheck(ctx context.Context, getenv func(string) string, environ []string, stdout io.Writer) int {
	r := &checkReport{out: stdout}

	// The user.
	r.check("runs as uid and gid 65532 (distroless's nonroot)",
		os.Getuid() == containerUser && os.Geteuid() == containerUser && os.Getgid() == containerUser && os.Getegid() == containerUser,
		"uid "+strconv.Itoa(os.Getuid())+", gid "+strconv.Itoa(os.Getgid()))

	// Capabilities and no-new-privileges, here and in serve.
	for _, process := range []struct{ label, pid string }{{"this process", "self"}, {"PID 1 (serve)", "1"}} {
		text, err := os.ReadFile("/proc/" + process.pid + "/status")
		if err != nil {
			r.check(process.label+" holds no capability and has no-new-privileges", false, "its status can't be read")
			continue
		}
		fields := parseProcStatus(string(text))
		held := privilegesHeld(fields)
		r.check(process.label+" holds no capability and has no-new-privileges", len(held) == 0, strings.Join(held, ", "))
		if process.pid == "1" {
			user := statusUser(fields)
			r.check("PID 1 runs as uid 65532", user == strconv.Itoa(containerUser), "uid "+user)
		}
	}
	cmdline, err := os.ReadFile("/proc/1/cmdline")
	r.check("PID 1 is the evaluator's serve", err == nil && commandLine(cmdline) == serveCommandLine,
		"its command line is "+strconv.Quote(commandLine(cmdline)))

	// The filesystem.
	mounts, err := os.ReadFile("/proc/self/mounts")
	options := rootMountOptions(string(mounts))
	// The why names the first options only (rw or ro, then the rest):
	// overlay's own lists the host's paths.
	r.check("the root filesystem is mounted read-only", err == nil && hasOption(options, "ro"),
		strings.Join(options[:min(len(options), 2)], ","))
	for _, directory := range []string{"/", "/app", "/tmp"} {
		refused, why := writeRefusedAsReadOnly(directory)
		r.check("writing to "+directory+" is refused (read-only)", refused, why)
	}

	// The network: first the positive control, inside.
	lookup, cancel := context.WithTimeout(ctx, selfcheckDialTimeout)
	ownResolved, err := net.DefaultResolver.LookupHost(lookup, selfcheckOwnName)
	cancel()
	ownCheck := selfcheckOwnName + " (this service) resolves to this container through Docker's DNS"
	if err != nil {
		r.check(ownCheck, false, "the lookup failed")
	} else if own, err := net.InterfaceAddrs(); err != nil {
		r.check(ownCheck, false, "this container's addresses can't be read")
	} else {
		passed, why := resolvesToSelf(ownResolved, own)
		r.check(ownCheck, passed, why)
	}
	if settings, err := LoadSettings(getenv); err != nil {
		r.check("serve answers on "+selfcheckOwnName, false, "the settings don't load")
	} else {
		address := net.JoinHostPort(selfcheckOwnName, strconv.Itoa(settings.Port))
		dialer := net.Dialer{Timeout: selfcheckDialTimeout}
		conn, err := dialer.DialContext(ctx, "tcp", address)
		if err == nil {
			_ = conn.Close()
		}
		r.check("serve answers on "+address, err == nil, "connecting: "+describe(err))
	}
	// Then the outside, which must not answer.
	for _, address := range selfcheckAddresses {
		dialer := net.Dialer{Timeout: selfcheckDialTimeout}
		conn, err := dialer.DialContext(ctx, "tcp", address)
		if err == nil {
			_ = conn.Close()
		}
		r.check(address+" doesn't answer", err != nil, "connected")
	}
	lookup, cancel = context.WithTimeout(ctx, selfcheckDialTimeout)
	resolved, err := net.DefaultResolver.LookupHost(lookup, selfcheckName)
	cancel()
	r.check(selfcheckName+" doesn't resolve", err != nil, "resolved to "+strings.Join(resolved, " "))

	// The secret: never in an environment.
	refused := refusedVariables(environ)
	r.check("no OTTL_EVALUATOR_SECRET variable but the files' names is set", len(refused) == 0, strings.Join(refused, ", "))
	if path := strings.TrimSpace(getenv(SecretFileVariable)); path == "" {
		r.check("the secret's file is named", false, SecretFileVariable+" is not set")
	} else if text, err := readSecretFile(SecretFileVariable, path); err != nil {
		r.check("the secret's file is readable", false, err.Error())
	} else {
		r.check("the secret's text is in no variable of this process",
			!secretInEnvironment([]string{strings.TrimSpace(text)}, environ), "found in a variable's value")
	}
	_, err = os.ReadFile("/proc/1/environ")
	r.check("PID 1's environment is refused (serve is not dumpable)", errors.Is(err, fs.ErrPermission),
		"reading /proc/1/environ: "+describe(err))

	// An evaluate child, started as serve starts one: from a non-dumpable
	// process, in its own process group, with the children's environment.
	if err := makeNotDumpable(); err != nil {
		r.check("an evaluate child starts, raises its oom_score_adj and answers", false, "this process couldn't be made non-dumpable")
	} else if self, err := os.Executable(); err != nil {
		r.check("an evaluate child starts, raises its oom_score_adj and answers", false, "this executable can't be found")
	} else {
		passed, why := runSelfcheckChild(ctx, []string{self})
		r.check("an evaluate child starts, raises its oom_score_adj and answers", passed, why)
	}

	return r.finish()
}

// writeRefusedAsReadOnly tries to create a file in directory, and says
// whether the filesystem refused it as read-only (EROFS, not merely a
// permission the user lacks).
func writeRefusedAsReadOnly(directory string) (bool, string) {
	path := filepath.Join(directory, ".selfcheck-"+strconv.Itoa(os.Getpid()))
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		_ = f.Close()
		_ = os.Remove(path)
		return false, "the write succeeded"
	}
	return errors.Is(err, syscall.EROFS), describe(err)
}

// describe names an error's errno, or says there was none.
func describe(err error) string {
	var errno syscall.Errno
	switch {
	case err == nil:
		return "no error"
	case errors.As(err, &errno):
		return errno.Error()
	default:
		return "an error"
	}
}
