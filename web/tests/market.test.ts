import { beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { centsToRaw, marketFeeCents, parsePrice, sellerCents } from "@/lib/market";

describe("market rules", () => {
  it("takes 7% rounded up to the cent, and parses prices", () => {
    expect(marketFeeCents(1000)).toBe(70);
    expect(marketFeeCents(101)).toBe(8);
    expect(sellerCents(1000)).toBe(930);
    expect(centsToRaw(1250, 6)).toBe(BigInt(12_500_000));
    expect(parsePrice("$12.50")).toBe(1250);
    expect(parsePrice("0.50")).toBeNull();
    expect(parsePrice("12.555")).toBeNull();
    expect(parsePrice("10,000")).toBe(1_000_000);
    expect(parsePrice("10001")).toBeNull();
  });
});

describe("market server (local KV)", () => {
  let col: typeof import("@/lib/server/collection");
  let mkt: typeof import("@/lib/server/market");
  let kvMod: typeof import("@/lib/server/kv");
  beforeAll(async () => {
    process.env.KV_LOCAL_FILE = join(tmpdir(), `mkt-test-${Date.now()}.json`);
    col = await import("@/lib/server/collection");
    mkt = await import("@/lib/server/market");
    kvMod = await import("@/lib/server/kv");
  });
  const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);
  let n = 0;
  /** win ranked duels against fresh opponents and open the crates: tradable copies */
  async function earn(w: string, wins: number) {
    await col.collectionOf(w);
    for (let k = 0; k < wins; k++) await col.onDuelSettled(`room-${w.slice(2, 6)}-${n++}`, w, "0x" + (n % 255).toString(16).padStart(2, "0").repeat(20));
    for (const c of (await col.collectionOf(w)).crates) await col.openCrate(w, c.id);
    return (await col.collectionOf(w)).copies.filter((c) => !c.bound && c.origin === "crate");
  }
  type Pay = { signer: string; destination: string; amount: bigint; fee: bigint };
  const TREASURY = "0x" + "7e".repeat(20);
  /** the buyer's two signed withdraws: pay (seller's share + network fee) and cut (7% to the treasury) */
  const buy = (signer: string, seller: string, t: { sellerRaw: string; feeRaw: string }, net: bigint) => ({
    pay: { signer, destination: seller, amount: BigInt(t.sellerRaw) + net, fee: net },
    cut: { signer, destination: TREASURY, amount: BigInt(t.feeRaw), fee: BigInt(0) },
  });
  const deps = (relay: (r: unknown) => Promise<{ success: boolean; txHash?: string }>, treasury: string | null = TREASURY) => ({
    parse: (r: unknown) => r as { pay: Pay; cut: Pay },
    treasury: () => treasury,
    networkFee: async () => BigInt(20_000),   // $0.02
    relay,
  });

  it("the same two pilots only pay a crate once a day", async () => {
    const P = "0x" + "e5".repeat(20), Q = "0x" + "f6".repeat(20);
    await col.collectionOf(P);
    const before = (await col.collectionOf(P)).crates.length;
    await col.onDuelSettled("pair-1", P, Q);
    await col.onDuelSettled("pair-2", P, Q);
    await col.onDuelSettled("pair-3", Q, P);   // the other way round is the same pair
    expect((await col.collectionOf(P)).crates.length).toBe(before + 1);
    await col.onDuelSettled("pair-4", P, C);
    expect((await col.collectionOf(P)).crates.length).toBe(before + 2);
  });

  it("lists a tradable copy; bound, starter and worn copies can't be listed; a listed copy can't be scrapped or flown", async () => {
    const mine = await earn(A, 3);
    expect(mine.length).toBe(3);
    const all = (await col.collectionOf(A)).copies;
    const bound = all.find((c) => c.bound && c.origin === "crate");
    if (bound) expect((await mkt.listCopy(A, bound.uid, 500)).ok).toBe(false);
    expect((await mkt.listCopy(A, all.find((c) => c.origin === "starter")!.uid, 500)).ok).toBe(false);
    expect((await mkt.listCopy(A, mine[0].uid, 50)).ok).toBe(false);   // under $1
    const l = await mkt.listCopy(A, mine[0].uid, 1000);
    expect(l.ok).toBe(true);
    expect((await mkt.listCopy(A, mine[0].uid, 1200)).ok).toBe(false);
    expect((await col.scrapCopy(A, mine[0].uid)).ok).toBe(false);
    const it = (await import("@/lib/collection")).itemById(mine[0].item)!;
    if (it.kind === "skin") expect((await col.equip(A, mine[0].uid, "trail-gold")).ok).toBe(false);
    const rows = await mkt.listings();
    expect(rows.some((r) => r.uid === mine[0].uid && r.copy?.serial === mine[0].serial)).toBe(true);
    if (l.ok) { expect((await mkt.unlist(B, l.listing.id)).ok).toBe(false); expect((await mkt.unlist(A, l.listing.id)).ok).toBe(true); }
    expect((await mkt.listings()).some((r) => r.uid === mine[0].uid)).toBe(false);
  });

  it("buying checks the payment, pays the seller price minus 7% and the treasury 7%, and moves the copy with its history", async () => {
    const mine = (await col.collectionOf(A)).copies.filter((c) => !c.bound && c.origin === "crate");
    const l = await mkt.listCopy(A, mine[0].uid, 1000);
    if (!l.ok) throw new Error(l.reason);
    const t = await mkt.buyTerms(l.listing.id);
    if ("ok" in t) throw new Error(t.reason);
    const net = BigInt(20_000);
    expect(BigInt(t.sellerRaw) + BigInt(t.feeRaw)).toBe(BigInt(t.priceRaw));
    const good = buy(B, A, t, net);
    let sent = 0;
    const ok = deps(async () => { sent++; return { success: true, txHash: "0xabc" }; });
    const bad = [
      { ...good, pay: { ...good.pay, destination: C } },                                   // not to the seller
      { ...good, pay: { ...good.pay, amount: good.pay.amount - BigInt(1) } },              // seller short
      { ...good, pay: { ...good.pay, fee: BigInt(0), amount: BigInt(t.sellerRaw) } },      // no network fee
      { ...good, pay: { ...good.pay, signer: C } },                                        // someone else's wallet
      { ...good, cut: { ...good.cut, destination: C } },                                   // 7% not to the treasury
      { ...good, cut: { ...good.cut, amount: good.cut.amount - BigInt(1) } },              // 7% short
      { ...good, cut: { ...good.cut, signer: C } },
    ];
    expect((await mkt.buyListing(A, l.listing.id, good, ok)).ok).toBe(false);   // own listing
    for (const b of bad) expect((await mkt.buyListing(B, l.listing.id, b, ok)).ok).toBe(false);
    expect((await mkt.buyListing(B, l.listing.id, good, deps(async () => ({ success: true }), null))).ok).toBe(false);   // no treasury: off
    expect(sent).toBe(0);
    const r = await mkt.buyListing(B, l.listing.id, good, ok);
    expect(r.ok).toBe(true);
    expect(sent).toBe(1);
    expect((await col.collectionOf(A)).copies.some((c) => c.uid === mine[0].uid)).toBe(false);
    const got = (await col.collectionOf(B)).copies.find((c) => c.uid === mine[0].uid);
    expect(got?.serial).toBe(mine[0].serial); expect(got?.burn).toBe(mine[0].burn);
    const rec = await col.copyRecord(mine[0].uid);
    expect(rec?.owner).toBe(B);
    expect(rec?.history.at(-1)).toMatchObject({ ev: "moved", from: A, to: B, via: "market", price: 1000, tx: "0xabc" });
    expect((await mkt.listingById(l.listing.id))?.state).toBe("sold");
    expect((await mkt.salesOf(mine[0].item))[0]).toMatchObject({ uid: mine[0].uid, price: 1000 });
    expect((await mkt.buyListing(C, l.listing.id, good, ok)).ok).toBe(false);
  });

  it("a payment that wasn't sent reopens the listing; one with no answer stays pending until settled", async () => {
    const mine = (await col.collectionOf(A)).copies.filter((c) => !c.bound && c.origin === "crate");
    const l = await mkt.listCopy(A, mine[0].uid, 500);
    if (!l.ok) throw new Error(l.reason);
    const t = await mkt.buyTerms(l.listing.id);
    if ("ok" in t) throw new Error(t.reason);
    const req = buy(C, A, t, BigInt(20_000));
    const notSent = deps(async () => { throw Object.assign(new Error("fee changed, please retry"), { notSent: true }); });
    expect((await mkt.buyListing(C, l.listing.id, req, notSent)).ok).toBe(false);
    expect((await mkt.listingById(l.listing.id))?.state).toBe("open");
    const reverted = deps(async () => ({ success: false, txHash: "0xdead" }));
    expect((await mkt.buyListing(C, l.listing.id, req, reverted)).ok).toBe(false);
    expect((await mkt.listingById(l.listing.id))?.state).toBe("open");
    const lost = deps(async () => { throw new Error("timeout"); });
    const r = await mkt.buyListing(C, l.listing.id, req, lost);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.pending).toBe(true);
    expect((await mkt.listingById(l.listing.id))?.state).toBe("pending");
    expect((await mkt.unlist(A, l.listing.id)).ok).toBe(false);
    expect((await mkt.buyListing(B, l.listing.id, buy(B, A, t, BigInt(20_000)), deps(async () => ({ success: true })))).ok).toBe(false);
    const s = await mkt.settleSale(l.listing.id, C, "0xfeed");
    expect("state" in s && s.state).toBe("sold");
    expect((await col.collectionOf(C)).copies.some((c) => c.uid === mine[0].uid)).toBe(true);
  });

  it("trade offers swap both sides at once; decline, cancel and stale copies are handled", async () => {
    const a = await earn(A, 2), b = await earn(B, 2);
    const ga = a.find((c) => !c.bound)!, gb = b.find((c) => !c.bound)!;
    expect((await mkt.makeOffer(A, A, [ga.uid], [])).ok).toBe(false);
    expect((await mkt.makeOffer(A, B, [], [])).ok).toBe(false);
    expect((await mkt.makeOffer(A, B, [gb.uid], [])).ok).toBe(false);   // not A's copy
    const o = await mkt.makeOffer(A, B, [ga.uid], [gb.uid]);
    if (!o.ok) throw new Error(o.reason);
    expect((await mkt.answerOffer(A, o.offer.id, "accept")).ok).toBe(false);   // only B accepts
    expect((await mkt.answerOffer(C, o.offer.id, "accept")).ok).toBe(false);
    const done = await mkt.answerOffer(B, o.offer.id, "accept");
    expect(done.ok && done.offer.state).toBe("accepted");
    expect((await col.collectionOf(B)).copies.some((c) => c.uid === ga.uid)).toBe(true);
    expect((await col.collectionOf(A)).copies.some((c) => c.uid === gb.uid)).toBe(true);
    expect((await col.copyRecord(ga.uid))?.history.at(-1)).toMatchObject({ ev: "moved", via: "trade", from: A, to: B, offer: o.offer.id });
    expect((await mkt.answerOffer(B, o.offer.id, "accept")).ok).toBe(false);
    // a copy listed after the offer was made blocks it
    const o2 = await mkt.makeOffer(B, A, [ga.uid], []);
    if (!o2.ok) throw new Error(o2.reason);
    await mkt.listCopy(B, ga.uid, 300);
    expect((await mkt.answerOffer(A, o2.offer.id, "accept")).ok).toBe(false);
    expect((await mkt.answerOffer(A, o2.offer.id, "decline")).ok).toBe(true);
    const o3 = await mkt.makeOffer(A, B, [gb.uid], []);
    if (!o3.ok) throw new Error(o3.reason);
    expect((await mkt.answerOffer(B, o3.offer.id, "cancel")).ok).toBe(false);
    expect((await mkt.answerOffer(A, o3.offer.id, "cancel")).ok).toBe(true);
    const list = await mkt.offersOf(A);
    expect(list.map((x) => x.state)).toEqual(expect.arrayContaining(["accepted", "declined", "cancelled"]));
    expect(list.find((x) => x.id === o.offer.id)?.giveCopies?.[0]?.uid).toBe(ga.uid);
  });

  it("a frozen copy comes off the market and can't be listed or traded", async () => {
    const a = (await col.collectionOf(A)).copies.filter((c) => !c.bound && c.origin === "crate");
    const l = await mkt.listCopy(A, a[0].uid, 900);
    expect(l.ok).toBe(true);
    await mkt.freezeCopy(a[0].uid, "reported stolen");
    expect((await mkt.listings()).some((r) => r.uid === a[0].uid)).toBe(false);
    expect((await mkt.listCopy(A, a[0].uid, 900)).ok).toBe(false);
    expect((await mkt.makeOffer(A, B, [a[0].uid], [])).ok).toBe(false);
    await mkt.unfreezeCopy(a[0].uid);
    expect((await mkt.listCopy(A, a[0].uid, 900)).ok).toBe(true);
    void kvMod;
  });
});
