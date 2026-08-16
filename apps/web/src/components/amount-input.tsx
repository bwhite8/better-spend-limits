"use client";

/**
 * A dollars-and-cents input that reports the minor-units string the wire wants.
 *
 * The validation rule is not restated here — it IS `dollarsInputToMinorUnits`
 * from `@bsl/shared` (§G9), the same function the server will run on the value.
 * A rejected value reports `null` upward, which is how Phase 10's dialog knows
 * to keep the submit button disabled and issue no network call at all.
 */

import { useId, useState } from "react";

import { dollarsInputToMinorUnits, MoneyFormatError } from "@bsl/shared";

import { FIELD } from "./controls";

export interface AmountInputProps {
  /** Initial dollar value, e.g. `"750.00"`. */
  defaultValue?: string;
  label?: string;
  name?: string;
  id?: string;
  disabled?: boolean;
  /**
   * Focus the field on mount. The dialogs that host this input render it only
   * once opened, so `autoFocus` fires exactly when the dialog appears — which is
   * where a keyboard user expects the caret to be.
   */
  autoFocus?: boolean;
  /**
   * Called on every keystroke with the minor-units string, or `null` while the
   * input is empty or invalid. The second argument is the validation message.
   */
  onValueChange?: (minorUnits: string | null, error: string | null) => void;
}

export interface ParsedAmountInput {
  /** The wire value, or `null` when the field is empty or invalid. */
  minorUnits: string | null;
  /** A message to show the user, or `null` when there is nothing wrong. */
  error: string | null;
}

/** The user-facing wording for a rejected amount (§G9 allows 2 decimal places). */
export const AMOUNT_INPUT_ERROR = "Enter a non-negative dollar amount with at most 2 decimal places.";

/**
 * The field's whole validation contract, as a pure function.
 *
 * Exported so it can be tested without a DOM and reused by Phase 10's dialog:
 * an empty field is not an error (nothing has been typed yet) but yields no
 * value either, which is how a submit button stays disabled without shouting
 * at somebody who has not finished.
 */
export function parseAmountInput(raw: string): ParsedAmountInput {
  if (raw.trim() === "") return { minorUnits: null, error: null };
  try {
    return { minorUnits: dollarsInputToMinorUnits(raw), error: null };
  } catch (error) {
    return {
      minorUnits: null,
      error: error instanceof MoneyFormatError ? AMOUNT_INPUT_ERROR : "Invalid amount.",
    };
  }
}

export function AmountInput({
  defaultValue = "",
  label = "Amount (USD)",
  name = "amount",
  id,
  disabled,
  autoFocus,
  onValueChange,
}: AmountInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [raw, setRaw] = useState(defaultValue);
  const [error, setError] = useState<string | null>(() => parseAmountInput(defaultValue).error);

  const handleChange = (next: string) => {
    setRaw(next);
    const result = parseAmountInput(next);
    setError(result.error);
    onValueChange?.(result.minorUnits, result.error);
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex items-center gap-1">
        <span aria-hidden="true" className="text-slate-500">
          $
        </span>
        <input
          id={inputId}
          name={name}
          value={raw}
          disabled={disabled}
          autoFocus={autoFocus}
          inputMode="decimal"
          autoComplete="off"
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : `${inputId}-error`}
          data-testid="amount-input"
          onChange={(event) => handleChange(event.target.value)}
          className={`${FIELD} w-36 tabular-nums`}
        />
      </div>
      {error === null ? null : (
        <p id={`${inputId}-error`} role="alert" data-testid="amount-error" className="text-xs text-danger-600">
          {error}
        </p>
      )}
    </div>
  );
}
