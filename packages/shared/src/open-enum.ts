import { z } from "zod";

/**
 * A string union that stays OPEN: the known members are typed (so editors
 * autocomplete them and typos in comparisons are caught) while any other string
 * is still assignable. `Record<never, never>` is the `{}` trick without the
 * empty-object-type lint violation.
 */
export type OpenEnum<TKnown extends string> = TKnown | (string & Record<never, never>);

/**
 * Schema for an open string enum. Parsing accepts ANY string — the Anthropic
 * APIs document their enumerations as open sets (`source.type`, request
 * `status`, `period`, error `type`), and a new member must never fail a read.
 * The known values exist only to shape the inferred TypeScript type.
 */
export function openEnum<const TKnown extends readonly string[]>(_known: TKnown) {
  return z.string().transform((value): OpenEnum<TKnown[number]> => value);
}
