// evalDistinct parses before it collects the records and calls the
// Checkpoint every CheckEveryRecords records, returning its error and no
// result; truncateDisplay keeps a sample within 120 bytes, its "…" included
// (D15a plan Preflight rulings 5 and 10).

package ottlassert

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/open-telemetry/opentelemetry-collector-contrib/pkg/ottl"
	"go.opentelemetry.io/collector/pdata/pcommon"
)

// evalDistinct evaluates rule.Expression per record (after the optional
// rule.Condition row filter), counts DISTINCT non-nil values, and compares
// the count against rule.Count. A nil result — an absent attribute — is
// excluded from the set, so `lte: 0` keeps its "this never appears" meaning.
func evalDistinct[K any](ctx context.Context, rule Rule, parser ottl.Parser[K], collect func() ([]evalRecord[K], error), check Checkpoint, res Result) (Result, error) {
	expr, err := parser.ParseValueExpression(rule.Expression)
	if err != nil {
		res.Error = fmt.Sprintf("invalid OTTL value expression: %s", err)
		return res, nil
	}
	var cond *ottl.Condition[K]
	if rule.Condition != "" {
		c, err := parser.ParseCondition(rule.Condition)
		if err != nil {
			res.Error = fmt.Sprintf("invalid OTTL condition: %s", err)
			return res, nil
		}
		cond = c
	}
	recs, err := collect()
	if err != nil {
		return Result{}, err
	}
	defer closeRecords(recs)
	res.TotalCount = len(recs)
	seen := make(map[string]struct{})
	var samples []string
	evalErrs := 0
	firstErr := ""
	t := newTicker(check)
	for _, rec := range recs {
		if err := t.tick(); err != nil {
			return Result{}, err
		}
		if cond != nil {
			ok, err := cond.Eval(ctx, rec.tCtx)
			if err != nil {
				evalErrs++
				if firstErr == "" {
					firstErr = err.Error()
				}
				continue
			}
			if !ok {
				continue
			}
		}
		res.MatchedCount++
		v, err := expr.Eval(ctx, rec.tCtx)
		if err != nil {
			evalErrs++
			if firstErr == "" {
				firstErr = err.Error()
			}
			continue
		}
		key, display, ok := distinctKey(v)
		if !ok {
			continue
		}
		if _, dup := seen[key]; !dup {
			seen[key] = struct{}{}
			if len(samples) < maxMisses {
				samples = append(samples, display)
			}
		}
	}
	if evalErrs > 0 {
		res.Error = fmt.Sprintf("evaluation failed on %d of %d records: %s", evalErrs, len(recs), firstErr)
		return res, nil
	}
	res.DistinctCount = len(seen)
	res.Passed = rule.Count.matches(int64(len(seen)))
	if !res.Passed {
		res.DistinctSamples = samples
	}
	return res, nil
}

// distinctKey canonicalizes one evaluated value into a set key plus a
// bounded display form. ok=false means nil (the record contributes
// nothing). Keys are type-prefixed so values of different types never
// collide — int64(5), float64(5), and "5" count as three distinct values.
func distinctKey(v any) (key string, display string, ok bool) {
	switch t := v.(type) {
	case nil:
		return "", "", false
	case string:
		return "s:" + t, truncateDisplay(t), true
	case bool:
		s := strconv.FormatBool(t)
		return "b:" + s, s, true
	case int64:
		s := strconv.FormatInt(t, 10)
		return "i:" + s, s, true
	case float64:
		s := strconv.FormatFloat(t, 'g', -1, 64)
		return "f:" + s, s, true
	case []byte:
		s := hex.EncodeToString(t)
		return "y:" + s, truncateDisplay("0x" + s), true
	case time.Time:
		s := t.UTC().Format(time.RFC3339Nano)
		return "t:" + s, s, true
	case time.Duration:
		return "d:" + t.String(), t.String(), true
	case pcommon.Value:
		return rawDistinctKey(t.AsRaw())
	case pcommon.Map:
		return rawDistinctKey(t.AsRaw())
	case pcommon.Slice:
		return rawDistinctKey(t.AsRaw())
	default:
		return rawDistinctKey(v)
	}
}

// rawDistinctKey handles pcommon AsRaw() shapes — map[string]any, []any,
// and scalars — plus any type distinctKey has no dedicated case for.
// encoding/json sorts map keys, so equal maps canonicalize identically.
func rawDistinctKey(v any) (string, string, bool) {
	if v == nil {
		return "", "", false
	}
	switch v.(type) {
	case string, bool, int64, float64, []byte, time.Time, time.Duration:
		return distinctKey(v)
	}
	b, err := json.Marshal(v)
	if err != nil {
		s := fmt.Sprintf("%T:%v", v, v)
		return s, truncateDisplay(s), true
	}
	return "j:" + string(b), truncateDisplay(string(b)), true
}

const maxDisplayBytes = 120

func truncateDisplay(s string) string {
	return truncateBytes(s, maxDisplayBytes)
}

// truncateBytes cuts s to at most limit bytes, "…" included, on a rune
// boundary, so the ellipsis never splits a UTF-8 sequence.
func truncateBytes(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := limit - len("…")
	for cut > 0 && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut] + "…"
}
