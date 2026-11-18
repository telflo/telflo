// New in D15a Task 2 (spec decision 10; plan Preflight ruling 12), after
// the opamp-server's management/secrets.go (ADR 0026) and the collector
// tester's secret file (ADR 0028). There is no opt-out.

package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// The secret's settings. The secret is read from a file, never from the
// environment: the process is made non-dumpable before it reads it, and a
// child process, whose exec resets that flag, gets an empty environment.
const (
	// SecretFileVariable names the current secret's file
	// (/run/secrets/ottl_evaluator_secret in compose).
	SecretFileVariable = "OTTL_EVALUATOR_SECRET_FILE"
	// PreviousSecretsFileVariable names a file of secrets still accepted
	// during a rotation, one per line (blank lines ignored).
	PreviousSecretsFileVariable = "OTTL_EVALUATOR_SECRETS_PREVIOUS_FILE"
	// SecretValueVariable is refused: the secret must be in no environment.
	SecretValueVariable = "OTTL_EVALUATOR_SECRET"
	// MinSecretBytes is a secret's shortest length, after trimming.
	MinSecretBytes = 32
	// maxSecretFileBytes bounds what is read of a secret's file.
	maxSecretFileBytes = 64 << 10
)

// Secrets are the accepted shared secrets: the current one and the previous
// ones. Only each secret's SHA-256 digest is kept, so the text never sits in
// a field a log line or an error could reach, and every comparison is
// between two 32-byte digests, so its time doesn't depend on a secret's
// length.
//
// Accepts is the only place a presented token meets a secret, and
// subtle.ConstantTimeCompare is the only comparison it uses (a test reads
// this package's source to hold that).
type Secrets struct {
	digests [][sha256.Size]byte
}

// NewSecrets keeps the current secret and the previous ones, each trimmed of
// surrounding whitespace; it refuses an empty or short one, naming its
// setting and never its text.
func NewSecrets(current string, previous []string) (*Secrets, error) {
	current = strings.TrimSpace(current)
	if current == "" {
		return nil, fmt.Errorf("%s: the file holds no secret", SecretFileVariable)
	}
	if len(current) < MinSecretBytes {
		return nil, fmt.Errorf("%s: the secret must be at least %d bytes", SecretFileVariable, MinSecretBytes)
	}
	s := &Secrets{digests: [][sha256.Size]byte{sha256.Sum256([]byte(current))}}
	for i, secret := range previous {
		secret = strings.TrimSpace(secret)
		if len(secret) < MinSecretBytes {
			return nil, fmt.Errorf("%s: secret %d of %d must be at least %d bytes",
				PreviousSecretsFileVariable, i+1, len(previous), MinSecretBytes)
		}
		s.digests = append(s.digests, sha256.Sum256([]byte(secret)))
	}
	return s, nil
}

// Accepts reports whether token is one of the secrets. It compares the
// token with every secret, never stopping at a match, so the time it takes
// doesn't say which one matched or whether one did.
func (s *Secrets) Accepts(token string) bool {
	presented := sha256.Sum256([]byte(token))
	matched := 0
	for i := range s.digests {
		matched |= subtle.ConstantTimeCompare(presented[:], s.digests[i][:])
	}
	return matched == 1
}

// count is how many secrets are accepted; serve logs it at start.
func (s *Secrets) count() int {
	return len(s.digests)
}

// LoadSecrets reads the secrets from their files. It refuses to go on when
// OTTL_EVALUATOR_SECRET is set (even empty), when the current secret's file
// isn't named or can't be read, when a secret is shorter than
// MinSecretBytes, or when a secret's text is in any environment variable.
// Its errors name settings, never a secret or a file's contents.
func LoadSecrets(getenv func(string) string, environ []string) (*Secrets, error) {
	for _, entry := range environ {
		if strings.HasPrefix(entry, SecretValueVariable+"=") {
			return nil, fmt.Errorf("%s is set: the secret must be in no environment; put it in a file named by %s",
				SecretValueVariable, SecretFileVariable)
		}
	}
	path := strings.TrimSpace(getenv(SecretFileVariable))
	if path == "" {
		return nil, fmt.Errorf("%s is not set", SecretFileVariable)
	}
	text, err := readSecretFile(SecretFileVariable, path)
	if err != nil {
		return nil, err
	}
	all := []string{strings.TrimSpace(text)}
	var previous []string
	if path := strings.TrimSpace(getenv(PreviousSecretsFileVariable)); path != "" {
		text, err := readSecretFile(PreviousSecretsFileVariable, path)
		if err != nil {
			return nil, err
		}
		for _, line := range strings.Split(text, "\n") {
			if line = strings.TrimSpace(line); line != "" {
				previous = append(previous, line)
			}
		}
	}
	secrets, err := NewSecrets(all[0], previous)
	if err != nil {
		return nil, err
	}
	if secretInEnvironment(append(all, previous...), environ) {
		return nil, errors.New("a secret is also in the environment: it must be in no environment (D15a Preflight ruling 12)")
	}
	return secrets, nil
}

// readSecretFile reads at most maxSecretFileBytes of a secret's file. Its
// error names the setting, not the path's contents.
func readSecretFile(variable, path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("%s: the file can't be read", variable)
	}
	defer f.Close()
	text, err := io.ReadAll(io.LimitReader(f, maxSecretFileBytes+1))
	if err != nil {
		return "", fmt.Errorf("%s: the file can't be read", variable)
	}
	if len(text) > maxSecretFileBytes {
		return "", fmt.Errorf("%s: the file is larger than %d bytes", variable, maxSecretFileBytes)
	}
	return string(text), nil
}

// secretInEnvironment says whether any secret's text appears in any
// environment variable's value. It runs once, at start, on the secrets'
// text before only their digests are kept: it is no comparison with a
// presented token (the constant-time scan allows it by name).
func secretInEnvironment(texts []string, environ []string) bool {
	found := false
	for _, entry := range environ {
		_, value, _ := strings.Cut(entry, "=")
		for _, text := range texts {
			if text != "" && strings.Contains(value, text) {
				found = true
			}
		}
	}
	return found
}
