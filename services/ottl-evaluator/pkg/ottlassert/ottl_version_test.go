// The evaluator is built on the OTTL of the catalogue's default collector
// version, so this test fails when go.mod's pkg/ottl version and the
// catalogue's default differ. Change both together (catalog/README.md,
// "Adding a collector version").
//
// It reads go.mod's text: debug.ReadBuildInfo lists no dependencies in a
// test binary. Both files are required; a missing one fails, never skips.

package ottlassert

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// moduleRoot is services/ottl-evaluator, seen from this package's directory
// (go test runs a package's tests in its own directory).
var moduleRoot = filepath.Join("..", "..")

const ottlModule = `github\.com/open-telemetry/opentelemetry-collector-contrib/pkg/ottl`

var (
	// A require line, in a require block or on its own:
	//   github.com/open-telemetry/opentelemetry-collector-contrib/pkg/ottl v0.162.0
	ottlRequireLine = regexp.MustCompile(`(?m)^[ \t]*(?:require[ \t]+)?` + ottlModule + `[ \t]+(v\S+)[ \t]*(?://.*)?$`)
	// A replace directive would build another version than the one required.
	ottlReplaceLine = regexp.MustCompile(`(?m)^[ \t]*(?:replace[ \t]+)?` + ottlModule + `(?:[ \t]+v\S+)?[ \t]*=>`)
	moduleLine      = regexp.MustCompile(`(?m)^module[ \t]+(\S+)[ \t]*$`)
)

func TestOTTLVersionIsTheCatalogueDefault(t *testing.T) {
	goMod, err := os.ReadFile(filepath.Join(moduleRoot, "go.mod"))
	if err != nil {
		t.Fatalf("reading go.mod: %v", err)
	}
	if m := moduleLine.FindSubmatch(goMod); m == nil || string(m[1]) != "github.com/telflo/ottl-evaluator" {
		t.Fatalf("%s is not the evaluator's module root", moduleRoot)
	}
	if ottlReplaceLine.Match(goMod) {
		t.Fatalf("go.mod replaces pkg/ottl; the evaluator must build the version it requires")
	}
	requires := ottlRequireLine.FindAllSubmatch(goMod, -1)
	if len(requires) != 1 {
		t.Fatalf("go.mod should require pkg/ottl exactly once, found %d", len(requires))
	}
	ottlVersion := string(requires[0][1])

	catalogPath := filepath.Join(moduleRoot, "..", "..", "catalog", "distributions", "otelcol-contrib.json")
	raw, err := os.ReadFile(catalogPath)
	if err != nil {
		t.Fatalf("reading the catalogue: %v", err)
	}
	var catalog struct {
		Versions []struct {
			Version string `json:"version"`
			Default bool   `json:"default"`
		} `json:"versions"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		t.Fatalf("parsing %s: %v", catalogPath, err)
	}
	var defaults []string
	for _, v := range catalog.Versions {
		if v.Default {
			defaults = append(defaults, v.Version)
		}
	}
	if len(defaults) != 1 {
		t.Fatalf("the catalogue should have exactly one default version, found %d: %v", len(defaults), defaults)
	}

	if want := "v" + defaults[0]; ottlVersion != want {
		t.Fatalf("go.mod requires pkg/ottl %s, but the catalogue's default collector is %s: move pkg/ottl (and pdata, componenttest) to %s",
			ottlVersion, defaults[0], want)
	}
}
