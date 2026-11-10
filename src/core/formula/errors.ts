import { ValidationError } from '../errors/index.js';

/** The first ": " outside quotes, where a reason turns into advice. */
function adviceStart(reason: string): number {
  let quoted = false;
  for (let i = 0; i < reason.length - 1; i++) {
    if (reason[i] === '"') quoted = !quoted;
    else if (!quoted && reason[i] === ':' && reason[i + 1] === ' ') return i;
  }
  return -1;
}

/** "Divides by zero at column 12.", or "Unexpected "km" at column 3: is an operator such as * missing?" */
function placed(reason: string, column: number): string {
  const colon = adviceStart(reason);
  return colon < 0 ? `${reason.replace(/\.$/, '')} at column ${column}.` : `${reason.slice(0, colon)} at column ${column}${reason.slice(colon)}`;
}

/**
 * The one error the formula language raises (#130). It is a validation error, so a tariff saved with a bad formula is
 * refused with a 422. `column` (1-based) is where the problem starts, when there is one place to point at.
 */
export class FormulaError extends ValidationError {
  readonly column?: number;
  readonly reason: string;

  constructor(reason: string, column?: number) {
    super(column === undefined ? reason : placed(reason, column), column === undefined ? { reason } : { reason, column });
    this.reason = reason;
    this.column = column;
  }
}
