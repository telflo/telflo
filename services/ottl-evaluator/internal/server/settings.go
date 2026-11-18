// The evaluator's settings (D15a spec decision 10; plan Preflight rulings 10
// and 12): the secret's files (secrets.go), the in-flight caps, the body caps
// and the OTTL object cap. A cap may be lowered, never raised past the
// ruling's value (the in-flight caps too, the controller's Ruling 33); a
// setting that doesn't parse refuses the start, never falling back to its
// default. D25 Task 3 added the lint's body cap
// (OTTL_EVALUATOR_MAX_LINT_BODY_BYTES) and its hard deadline.

package server

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/telflo/ottl-evaluator/internal/rules"
)

// The settings' variables.
const (
	PortVariable             = "OTTL_EVALUATOR_PORT"
	HostVariable             = "OTTL_EVALUATOR_HOST"
	MaxEvaluationsVariable   = "OTTL_EVALUATOR_MAX_EVALUATIONS"
	MaxValidationsVariable   = "OTTL_EVALUATOR_MAX_VALIDATIONS"
	MaxEvaluateBodyVariable  = "OTTL_EVALUATOR_MAX_EVALUATE_BODY_BYTES"
	MaxValidateBodyVariable  = "OTTL_EVALUATOR_MAX_VALIDATE_BODY_BYTES"
	MaxLintBodyVariable      = "OTTL_EVALUATOR_MAX_LINT_BODY_BYTES"
	MaxOutputObjectsVariable = "OTTL_EVALUATOR_MAX_OUTPUT_OBJECTS"
)

// The rulings' values (Preflight ruling 10).
const (
	DefaultPort = 8003
	// DefaultMaxEvaluations is how many evaluations run at once, as the
	// tester's runs at once (its OTELCOL_TESTING_MAX_CONCURRENCY). It and
	// DefaultMaxValidations may be lowered, never raised (the controller's
	// Ruling 33): each child is a whole Go runtime with its own threads, and
	// compose's pids_limit, which counts threads, is sized for serve and
	// these many children at once.
	DefaultMaxEvaluations = 4
	DefaultMaxValidations = 8
	// DefaultMaxEvaluateBodyBytes: a 10 MiB output in base64 (13.3 MiB),
	// a log of 262,144 characters in JSON (up to 1.5 MiB escaped), and 200
	// rules of up to 8 KiB each, escaped.
	DefaultMaxEvaluateBodyBytes = 36 << 20
	DefaultMaxValidateBodyBytes = 64 << 10
	DefaultEvaluateWait         = 5 * time.Second
	DefaultValidateWait         = 1 * time.Second
	// DefaultMaxLintBodyBytes (D25 Task 3; plan Preflight ruling 13): 200
	// texts of up to 8,192 characters each, escaped (up to six bytes a
	// character as \u00XX).
	DefaultMaxLintBodyBytes = 10 << 20
	// DefaultEvaluateSoftDeadline is checked inside the child; the child's
	// process group is killed at DefaultEvaluateHardDeadline.
	DefaultEvaluateSoftDeadline = 20 * time.Second
	DefaultEvaluateHardDeadline = 25 * time.Second
	DefaultValidateHardDeadline = 2 * time.Second
	// DefaultLintHardDeadline is when a lint's child is killed (D25 Task 3):
	// the items it hasn't reached are "Not checked". 200 texts nested 12
	// deep parse in about half a second.
	DefaultLintHardDeadline = 10 * time.Second
)

// Settings are the server's limits. Serve loads them from the environment;
// tests build them with DefaultSettings and change what they need (the
// waits and deadlines are settable only there).
type Settings struct {
	Host string
	Port int

	MaxEvaluations       int
	MaxValidations       int
	MaxEvaluateBodyBytes int64
	MaxValidateBodyBytes int64
	MaxLintBodyBytes     int64
	MaxOutputObjects     int

	EvaluateWait         time.Duration
	ValidateWait         time.Duration
	EvaluateSoftDeadline time.Duration
	EvaluateHardDeadline time.Duration
	ValidateHardDeadline time.Duration
	LintHardDeadline     time.Duration
}

// DefaultSettings are the rulings' values.
func DefaultSettings() Settings {
	return Settings{
		Port:                 DefaultPort,
		MaxEvaluations:       DefaultMaxEvaluations,
		MaxValidations:       DefaultMaxValidations,
		MaxEvaluateBodyBytes: DefaultMaxEvaluateBodyBytes,
		MaxValidateBodyBytes: DefaultMaxValidateBodyBytes,
		MaxLintBodyBytes:     DefaultMaxLintBodyBytes,
		MaxOutputObjects:     rules.DefaultMaxOutputObjects,
		EvaluateWait:         DefaultEvaluateWait,
		ValidateWait:         DefaultValidateWait,
		EvaluateSoftDeadline: DefaultEvaluateSoftDeadline,
		EvaluateHardDeadline: DefaultEvaluateHardDeadline,
		ValidateHardDeadline: DefaultValidateHardDeadline,
		LintHardDeadline:     DefaultLintHardDeadline,
	}
}

// LoadSettings reads the settings from the environment: unset means the
// default. Its errors name the variable, never its value.
func LoadSettings(getenv func(string) string) (Settings, error) {
	s := DefaultSettings()
	var err error
	if s.Host, err = loadHost(getenv); err != nil {
		return Settings{}, err
	}
	ints := []struct {
		variable string
		min, max int64
		set      func(int64)
	}{
		{PortVariable, 1, 65535, func(v int64) { s.Port = int(v) }},
		{MaxEvaluationsVariable, 1, DefaultMaxEvaluations, func(v int64) { s.MaxEvaluations = int(v) }},
		{MaxValidationsVariable, 1, DefaultMaxValidations, func(v int64) { s.MaxValidations = int(v) }},
		{MaxEvaluateBodyVariable, 1, DefaultMaxEvaluateBodyBytes, func(v int64) { s.MaxEvaluateBodyBytes = v }},
		{MaxValidateBodyVariable, 1, DefaultMaxValidateBodyBytes, func(v int64) { s.MaxValidateBodyBytes = v }},
		{MaxLintBodyVariable, 1, DefaultMaxLintBodyBytes, func(v int64) { s.MaxLintBodyBytes = v }},
		{MaxOutputObjectsVariable, 1, rules.DefaultMaxOutputObjects, func(v int64) { s.MaxOutputObjects = int(v) }},
	}
	for _, setting := range ints {
		raw := strings.TrimSpace(getenv(setting.variable))
		if raw == "" {
			continue
		}
		v, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || v < setting.min || v > setting.max {
			return Settings{}, fmt.Errorf("%s must be a whole number from %d to %d", setting.variable, setting.min, setting.max)
		}
		setting.set(v)
	}
	return s, nil
}

// loadHost is the IP address to listen on: every interface when unset.
func loadHost(getenv func(string) string) (string, error) {
	host := strings.TrimSpace(getenv(HostVariable))
	if host != "" && net.ParseIP(host) == nil {
		return "", fmt.Errorf("%s must be an IP address", HostVariable)
	}
	return host, nil
}
