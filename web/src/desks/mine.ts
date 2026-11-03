import { useApp } from "../store";
import { useMay } from "../api/session";
import type { Move, NextStep } from "../domain/turn";
import type { Action, Trip } from "../domain/types";

/** The action each step asks for, so "your turn" only shows to someone allowed to take it. */
const MOVE_ACTION: Partial<Record<Move, Action["type"]>> = {
  plan: "trip.update", request: "request.create", issue: "request.issue", dispatch: "trip.dispatch", "confirm-load": "load.record",
  "confirm-delivery": "delivery.record", shortage: "shortage.decide", end: "trip.end", expenses: "expense.record", settle: "settlement.post",
};

/** Is this trip's next step this desk's, and may this person take it? Approvals follow the policy (`mayDecide`). */
export function useMine() {
  const { data, role } = useApp();
  const may = useMay();
  return (trip: Trip, step: NextStep) => {
    if (step.actor !== role) return false;
    if (step.move === "approve" || step.move === "owner-approve") return data.requests.some((r) => r.tripId === trip.id && r.mayDecide);
    const action = MOVE_ACTION[step.move];
    return !action || may(action);
  };
}
