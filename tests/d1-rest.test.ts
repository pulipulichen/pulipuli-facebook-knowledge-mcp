import { describe, expect, it, vi } from "vitest";
import { createD1RestBinding } from "../scripts/d1-rest";

function binding(fetcher: typeof fetch) {
  return createD1RestBinding({ accountId: "account", databaseId: "database", apiToken: "secret", fetcher, minIntervalMs: 0 });
}
const ok = (results: unknown[]) => new Response(JSON.stringify({ success: true, result: results }));

describe("Actions D1 REST adapter", () => {
  it("preserves bound values and D1 row/meta formats without interpolating SQL", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok([{ success: true, results: [{ value: "中文'quoted" }], meta: { changes: 1 } }]));
    const db = binding(fetcher);
    expect(await db.prepare("SELECT value WHERE x = ? AND y = ? AND z = ?").bind("中文'quoted", 42, null).first("value")).toBe("中文'quoted");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      sql: "SELECT value WHERE x = ? AND y = ? AND z = ?", params: ["中文'quoted", 42, null],
    });
    expect(fetcher.mock.calls[0][0]).toBe("https://api.cloudflare.com/client/v4/accounts/account/d1/database/database/query");
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer secret");
  });

  it("submits related article/checkpoint writes as one parameterized REST batch", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok([{ success: true, meta: { changes: 1 } }, { success: true, meta: { changes: 2 } }]));
    const db = binding(fetcher);
    const result = await db.batch([db.prepare("UPDATE a SET x = ?").bind(1), db.prepare("DELETE FROM b WHERE id = ?").bind("id")]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ batch: [
      { sql: "UPDATE a SET x = ?", params: [1] }, { sql: "DELETE FROM b WHERE id = ?", params: ["id"] },
    ] });
    expect(result[1].meta.changes).toBe(2);
  });

  it("rejects HTTP, envelope, and per-query errors without replaying writes", async () => {
    for (const reply of [new Response("secret SQL", { status: 503 }), new Response(JSON.stringify({ success: false, errors: [{ code: 1234, message: "D1 unavailable" }] })), ok([{ success: false, error: "Transaction rolled back" }]), ok([])]) {
      const fetcher = vi.fn().mockResolvedValue(reply);
      await expect(binding(fetcher).prepare("UPDATE sync_lock SET token = ?").bind("lease").run()).rejects.toThrow(/D1/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});
