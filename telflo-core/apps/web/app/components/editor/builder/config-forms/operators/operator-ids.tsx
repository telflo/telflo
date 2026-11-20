import { createContext, useContext, type ReactNode } from "react";

/*
 * Every id in an operator card is the card's own: `op-<index>-<field>`.
 * Fixed ids (`json-parse-from`, `severity-enable`, …) would be shared by
 * every card, so a label clicked in the second JSON parser would toggle the
 * first one's box. The index is the card's position, never a value.
 */

const OperatorIndexContext = createContext<number | null>(null);

/** Gives a card's fields their card's index. */
export function OperatorIdProvider({ index, children }: { index: number; children: ReactNode }) {
  return <OperatorIndexContext.Provider value={index}>{children}</OperatorIndexContext.Provider>;
}

/** The card's id for a field: `op-<index>-<field>`. */
export function useOperatorId(): (field: string) => string {
  const index = useContext(OperatorIndexContext);
  if (index === null) throw new Error("An operator field is outside an operator card.");
  return (field) => `op-${index}-${field}`;
}
