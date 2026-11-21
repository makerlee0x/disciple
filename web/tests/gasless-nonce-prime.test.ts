import { describe, expect, it } from "vitest";
import { NonceBook } from "../lib/trade/gaslessPermit2";

const A = "0x00000000000000000000000000000000000000aa" as const;

describe("NonceBook.prime", () => {
  it("reads word 0 once off-tap; the next pick needs no read and takes the lowest free bit", async () => {
    let reads = 0;
    const book = new NonceBook(async () => { reads++; return BigInt(0b101); });
    await book.prime(A);
    await book.prime(A);
    expect(reads).toBe(1);
    expect(await book.next(A)).toBe(BigInt(1));
    expect(await book.next(A)).toBe(BigInt(3));
    expect(reads).toBe(1);
  });
  it("a prime racing a pick never hands out the same bit twice", async () => {
    const book = new NonceBook(async () => BigInt(0));
    const [, a, b] = await Promise.all([book.prime(A), book.next(A), book.next(A)]);
    expect(a).toBe(BigInt(0));
    expect(b).toBe(BigInt(1));
  });
});
