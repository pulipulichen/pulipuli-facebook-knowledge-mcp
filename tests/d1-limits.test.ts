import { describe, expect, it } from "vitest";
import { D1_MAX_BOUND_PARAMETERS, maxRowsPerD1Insert } from "../src/d1-limits";

describe("Cloudflare D1 bound parameter limit", () => {
  it("keeps chunk inserts with eight bound values per row within 100 variables", () => {
    const rowsPerStatement = maxRowsPerD1Insert(8);
    expect(D1_MAX_BOUND_PARAMETERS).toBe(100);
    expect(rowsPerStatement).toBe(12);
    expect(rowsPerStatement * 8).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    expect((rowsPerStatement + 1) * 8).toBeGreaterThan(D1_MAX_BOUND_PARAMETERS);

    const rows = Array.from({ length: 101 }, (_, i) => i);
    const batches = [];
    for (let start = 0; start < rows.length; start += rowsPerStatement) {
      batches.push(rows.slice(start, start + rowsPerStatement));
    }
    expect(batches.map((batch) => batch.length)).toEqual([12, 12, 12, 12, 12, 12, 12, 12, 5]);
  });

  it("supports other SQL layouts and rejects invalid row widths", () => {
    expect(maxRowsPerD1Insert(1)).toBe(100);
    expect(maxRowsPerD1Insert(100)).toBe(1);
    for (const invalid of [0, -1, 101, 2.5, Number.NaN]) {
      expect(() => maxRowsPerD1Insert(invalid)).toThrow(RangeError);
    }
  });
});
