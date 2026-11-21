import { useEffect, useState } from "react";

/**
 * `value`, once it has stopped changing for `delay` milliseconds: a
 * search's term, sent after a pause. Moved from routes/configurations.tsx
 * for the Users page's search too.
 */
export function useSettled<Value>(value: Value, delay: number): Value {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
