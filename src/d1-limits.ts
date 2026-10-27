/**
 * Cloudflare D1 allows at most 100 bound parameters per SQL statement.
 * db.batch() does not raise the per-statement limit.
 * https://developers.cloudflare.com/d1/platform/limits/
 */
export const D1_MAX_BOUND_PARAMETERS = 100;

export function maxRowsPerD1Insert(parametersPerRow: number): number {
  if (!Number.isInteger(parametersPerRow) || parametersPerRow < 1 || parametersPerRow > D1_MAX_BOUND_PARAMETERS) {
    throw new RangeError("Invalid number of bound parameters per row");
  }
  return Math.floor(D1_MAX_BOUND_PARAMETERS / parametersPerRow);
}
