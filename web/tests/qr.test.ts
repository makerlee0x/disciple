import { describe, expect, it } from "vitest";
import { qrMatrix } from "@/lib/qr";

describe("qrMatrix", () => {
  it("fits a 42-character address in version 3 (29 modules) with the three finder patterns", () => {
    const m = qrMatrix("0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A");
    expect(m.length).toBe(29);
    for (const [x, y] of [[0, 0], [22, 0], [0, 22]]) {
      expect(m[y][x] && m[y][x + 6] && m[y + 6][x] && m[y + 3][x + 3]).toBe(true);
      expect(m[y + 1][x + 1]).toBe(false);
    }
  });
  it("refuses text past version 6", () => { expect(() => qrMatrix("x".repeat(200))).toThrow(); });
});
