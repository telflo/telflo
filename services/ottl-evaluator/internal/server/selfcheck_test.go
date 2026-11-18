// New in D15a Task 3 (plan Preflight ruling 13): the selfcheck's parsing
// and its child check. The checks that read /proc run in the container
// (scripts/check-container.sh). D15a Task 3's follow-up (the controller's
// Ruling 34) adds TestResolvesToSelf, the network's positive control.

package server

import (
	"bytes"
	"context"
	"net"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestParseProcStatusAndThePrivilegesHeld(t *testing.T) {
	lockedDown := "Name:\tottl-evaluator\nUid:\t65532\t65532\t65532\t65532\nCapInh:\t0000000000000000\n" +
		"CapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\n" +
		"CapAmb:\t0000000000000000\nNoNewPrivs:\t1\n"
	fields := parseProcStatus(lockedDown)
	if held := privilegesHeld(fields); len(held) != 0 {
		t.Fatalf("a locked-down status holds %v", held)
	}
	if user := statusUser(fields); user != "65532" {
		t.Fatalf("uid %q", user)
	}

	cases := map[string]struct {
		from, to string
		want     []string
	}{
		"Docker's default bounding set":        {"CapBnd:\t0000000000000000", "CapBnd:\t00000000a80425fb", []string{"CapBnd 00000000a80425fb"}},
		"an effective capability":              {"CapEff:\t0000000000000000", "CapEff:\t0000000000000400", []string{"CapEff 0000000000000400"}},
		"no no-new-privileges":                 {"NoNewPrivs:\t1", "NoNewPrivs:\t0", []string{"NoNewPrivs 0"}},
		"a missing capability line":            {"CapAmb:\t0000000000000000\n", "", []string{"CapAmb "}},
		"a capability line that doesn't parse": {"CapInh:\t0000000000000000", "CapInh:\tnope", []string{"CapInh nope"}},
		"a missing NoNewPrivs line":            {"NoNewPrivs:\t1\n", "", []string{"NoNewPrivs "}},
	}
	for name, c := range cases {
		changed := strings.Replace(lockedDown, c.from, c.to, 1)
		if changed == lockedDown {
			t.Fatalf("%s: the case changes nothing", name)
		}
		if held := privilegesHeld(parseProcStatus(changed)); !reflect.DeepEqual(held, c.want) {
			t.Errorf("%s: held %q, want %q", name, held, c.want)
		}
	}
	if user := statusUser(parseProcStatus("Name:\tx\n")); user != "" {
		t.Errorf("no Uid line: %q", user)
	}
}

func TestRootMountOptionsReadsTheMountInEffect(t *testing.T) {
	mounts := "overlay / overlay rw,relatime,lowerdir=/a 0 0\n" +
		"proc /proc proc rw,nosuid 0 0\n" +
		"overlay / overlay ro,relatime,lowerdir=/b 0 0\n" +
		"tmpfs /dev tmpfs rw 0 0\n"
	options := rootMountOptions(mounts)
	if !hasOption(options, "ro") || hasOption(options, "rw") {
		t.Fatalf("the last mount at / is read-only, got %v", options)
	}
	if options := rootMountOptions("overlay / overlay rw,relatime 0 0\noverlay /app overlay ro 0 0\n"); hasOption(options, "ro") {
		t.Fatalf("a read-only mount elsewhere isn't the root's: %v", options)
	}
	if options := rootMountOptions("proc /proc proc rw 0 0\n"); options != nil {
		t.Fatalf("no mount at /: %v", options)
	}
	if hasOption([]string{"rw", "relatime"}, "ro") || hasOption(nil, "ro") {
		t.Fatal("ro found where there is none")
	}
}

func TestRefusedVariablesAllowsOnlyTheFilesNames(t *testing.T) {
	environ := []string{
		"PATH=/usr/bin",
		"OTTL_EVALUATOR_SECRET_FILE=/run/secrets/ottl_evaluator_secret",
		"OTTL_EVALUATOR_SECRETS_PREVIOUS_FILE=/run/secrets/previous",
		"OTTL_EVALUATOR_PORT=8003",
	}
	if refused := refusedVariables(environ); len(refused) != 0 {
		t.Fatalf("the files' names are refused: %v", refused)
	}
	environ = append(environ, "OTTL_EVALUATOR_SECRET=", "OTTL_EVALUATOR_SECRETS_PREVIOUS=x", "OTTL_EVALUATOR_SECRET_VALUE=y")
	want := []string{"OTTL_EVALUATOR_SECRET", "OTTL_EVALUATOR_SECRETS_PREVIOUS", "OTTL_EVALUATOR_SECRET_VALUE"}
	if refused := refusedVariables(environ); !reflect.DeepEqual(refused, want) {
		t.Fatalf("refused %v, want %v", refused, want)
	}
}

func TestResolvesToSelf(t *testing.T) {
	own := []net.Addr{
		&net.IPNet{IP: net.ParseIP("127.0.0.1"), Mask: net.CIDRMask(8, 32)},
		&net.IPNet{IP: net.ParseIP("172.30.0.2"), Mask: net.CIDRMask(16, 32)},
	}
	if passed, why := resolvesToSelf([]string{"172.30.0.2"}, own); !passed {
		t.Fatalf("this container's own address: %s", why)
	}
	if passed, _ := resolvesToSelf([]string{"172.30.0.9", "172.30.0.2"}, own); !passed {
		t.Fatal("one of the addresses is this container's")
	}
	cases := map[string]struct {
		resolved []string
		why      string
	}{
		"no address":             {nil, "no address"},
		"another container's":    {[]string{"172.30.0.3"}, "resolved to 172.30.0.3, not this container's address"},
		"in its network, not it": {[]string{"172.30.255.255"}, "resolved to 172.30.255.255, not this container's address"},
		"not an address":         {[]string{"telflo"}, "resolved to telflo, not this container's address"},
	}
	for name, c := range cases {
		if passed, why := resolvesToSelf(c.resolved, own); passed || why != c.why {
			t.Errorf("%s: passed %v, %q", name, passed, why)
		}
	}
	if passed, _ := resolvesToSelf([]string{"172.30.0.2"}, []net.Addr{&net.IPAddr{IP: net.ParseIP("172.30.0.2")}}); !passed {
		t.Error("an address given without its mask counts too")
	}
}

func TestCommandLineJoinsProcCmdline(t *testing.T) {
	if got := commandLine([]byte("/app/ottl-evaluator\x00serve\x00")); got != serveCommandLine {
		t.Fatalf("%q", got)
	}
	if got := commandLine([]byte("/app/ottl-evaluator\x00selfcheck\x00")); got == serveCommandLine {
		t.Fatalf("selfcheck taken for serve: %q", got)
	}
}

func TestCheckReportPrintsEachCheckAndFailsOnAny(t *testing.T) {
	var out bytes.Buffer
	r := &checkReport{out: &out}
	r.check("one", true, "unused")
	if code := r.finish(); code != 0 || out.String() != "ok one\nevery check passed\n" {
		t.Fatalf("exit %d, %q", code, out.String())
	}
	out.Reset()
	r = &checkReport{out: &out}
	r.check("one", true, "")
	r.check("two", false, "why")
	if code := r.finish(); code != 1 || out.String() != "ok one\nFAIL two: why\n1 check(s) failed\n" {
		t.Fatalf("exit %d, %q", code, out.String())
	}
}

// The child check runs the real evaluate child (this test binary answers
// it, main_test.go's TestMain), and fails with one that crashes.
func TestTheSelfchecksChildCheck(t *testing.T) {
	if passed, why := runSelfcheckChild(context.Background(), []string{os.Args[0]}); !passed {
		t.Fatalf("the real child: %s", why)
	}
	if passed, _ := runSelfcheckChild(context.Background(), []string{os.Args[0], crashChild}); passed {
		t.Fatal("a crashing child passed")
	}
}
