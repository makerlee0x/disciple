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

  it("admin test grant makes listable copies and skips prestige items", async () => {
    const T = "0x" + "9a".repeat(20);
    const items = (await import("@/lib/collection")).ITEMS;
    const skin = items.find((i) => i.kind === "skin")!, trail = items.find((i) => i.kind === "trail" && !i.prestige)!, tag = items.find((i) => i.kind === "tag" && !i.prestige)!;
    const r = await col.grantTestCopies(T, [skin.id, trail.id, tag.id, "tag-prestige-1", "nope"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.copies.map((c) => c.item)).toEqual([skin.id, trail.id, tag.id]);
    expect(r.skipped).toEqual(["tag-prestige-1", "nope"]);
    for (const c of r.copies) expect((await mkt.listCopy(T, c.uid, 500)).ok).toBe(true);
  });

  it("tradable supply stops at the cap: a sold-out item can't be granted again", async () => {
    const { ITEMS, supplyCap } = await import("@/lib/collection");
    const myth = ITEMS.find((i) => i.rar === "mythic" && !i.prestige && i.kind === "skin")!;
    expect(supplyCap(myth)).toBe(12);
    const U = "0x" + "8b".repeat(20);
    const r = await col.grantTestCopies(U, Array(14).fill(myth.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.copies).toHaveLength(12);
    expect(r.skipped).toHaveLength(2);
    expect((await col.soldOut()).has(myth.id)).toBe(true);
  });

  it("the same two pilots only pay a crate once a day", async () => {
    const P = "0x" + "e5".repeat(20), Q = "0x" + "f6".repeat(20);
    // duel crates only (the first win also pays the welcome crate, once)
    const duelCrates = async () => (await col.collectionOf(P)).crates.filter((c) => c.src.startsWith("duel:")).length;
    const before = await duelCrates();
    await col.onDuelSettled("pair-1", P, Q);
    await col.onDuelSettled("pair-2", P, Q);
    await col.onDuelSettled("pair-3", Q, P);   // the other way round is the same pair
    expect(await duelCrates()).toBe(before + 1);
    await col.onDuelSettled("pair-4", P, C);
    expect(await duelCrates()).toBe(before + 2);
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
    expect(await kvMod.kv().zrange(mkt.MKT.bought(B), 10, true)).toContain(l.listing.id);   // the buyer's Flight log index
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

  /** B's tradable copies that aren't listed, frozen or flown */
  async function free(w: string) {
    const c = await col.collectionOf(w);
    const worn = new Set(Object.values(c.equippedCopy ?? {}));
    const out: typeof c.copies = [];
    for (const x of c.copies) if (!x.bound && x.origin === "crate" && !worn.has(x.uid) && !(await col.isListed(x.uid)) && !(await col.frozenReason(x.uid))) out.push(x);
    return out;
  }
  const NET = BigInt(20_000);
  const okRelay = () => deps(async () => ({ success: true, txHash: "0x0ff" }));

  it("a private sale is off /market and only the pilot it's for can buy it, with the 7% fee", async () => {
    const b = await earn(B, 2);
    const g = (await free(B))[0] ?? b[0];
    expect((await mkt.listCopy(B, g.uid, 50, undefined, undefined, { to: A })).ok).toBe(false);   // $1 minimum
    expect((await mkt.listCopy(B, g.uid, 800, undefined, undefined, { to: B })).ok).toBe(false);  // not to yourself
    expect((await mkt.listCopy(B, g.uid, 800, undefined, undefined, { to: "@nobody_here_xyz" })).ok).toBe(false);
    const l = await mkt.listCopy(B, g.uid, 800, undefined, undefined, { to: A });
    if (!l.ok) throw new Error(l.reason);
    expect(l.listing.to).toBe(A);
    expect((await mkt.listings()).some((r) => r.id === l.listing.id)).toBe(false);
    expect((await mkt.myListings(A)).some((r) => r.id === l.listing.id && r.to === A)).toBe(true);
    expect((await mkt.myListings(B)).some((r) => r.id === l.listing.id)).toBe(true);
    const t = await mkt.buyTerms(l.listing.id);
    if ("ok" in t) throw new Error(t.reason);
    expect((await mkt.buyListing(C, l.listing.id, buy(C, B, t, NET), okRelay())).ok).toBe(false);
    const r = await mkt.buyListing(A, l.listing.id, buy(A, B, t, NET), okRelay());
    expect(r.ok).toBe(true);
    expect((await col.copyRecord(g.uid))?.history.at(-1)).toMatchObject({ ev: "moved", via: "market", from: B, to: A, price: 800 });
    expect((await mkt.myListings(A)).some((x) => x.id === l.listing.id)).toBe(false);   // gone from "for you" once sold
  });

  it("cash offers: checks, decline, replace, accept makes a private sale the offerer pays for", async () => {
    await earn(B, 2);
    const [g, h] = await free(B);
    expect((await mkt.makeOffer(B, g.uid, 900)).ok).toBe(false);                 // your own copy
    expect((await mkt.makeOffer(A, g.uid, 50)).ok).toBe(false);                  // under $1
    expect((await mkt.makeOffer(A, "0000000000000000", 900)).ok).toBe(false);   // no such copy
    const starter = (await col.collectionOf(B)).copies.find((c) => c.origin === "starter");
    if (starter) expect((await mkt.makeOffer(A, starter.uid, 900)).ok).toBe(false);
    // listed publicly at $20: an offer has to be under it
    const pub = await mkt.listCopy(B, g.uid, 2000);
    if (!pub.ok) throw new Error(pub.reason);
    expect((await mkt.makeOffer(A, g.uid, 2000)).ok).toBe(false);
    const o1 = await mkt.makeOffer(A, g.uid, 1200);
    if (!o1.ok) throw new Error(o1.reason);
    expect(o1.offer).toMatchObject({ from: A, to: B, uid: g.uid, price: 1200, state: "open" });
    expect((await mkt.answerOffer(A, o1.offer.id, "accept")).ok).toBe(false);    // only the owner answers
    expect((await mkt.answerOffer(C, o1.offer.id, "decline")).ok).toBe(false);
    expect((await mkt.answerOffer(B, o1.offer.id, "decline")).ok).toBe(true);
    expect((await mkt.answerOffer(B, o1.offer.id, "accept")).ok).toBe(false);
    // a second offer on the same copy replaces the first
    const o2 = await mkt.makeOffer(A, g.uid, 1300);
    const o3 = await mkt.makeOffer(A, g.uid, 1500);
    if (!o2.ok || !o3.ok) throw new Error("offer");
    expect((await mkt.offersOf(B)).find((x) => x.id === o2.offer.id)?.state).toBe("cancelled");
    const acc = await mkt.answerOffer(B, o3.offer.id, "accept");
    if (!acc.ok) throw new Error(acc.reason);
    expect(acc.offer.state).toBe("accepted");
    expect((await mkt.listingById(pub.listing.id))?.state).toBe("closed");      // the public listing came down
    const priv = await mkt.listingById(acc.offer.listing!);
    expect(priv).toMatchObject({ state: "open", to: A, price: 1500, offer: o3.offer.id });
    expect((await mkt.listings()).some((x) => x.uid === g.uid)).toBe(false);
    const t = await mkt.buyTerms(priv!.id);
    if ("ok" in t) throw new Error(t.reason);
    expect(t.fee).toBe(105);   // 7% of $15
    expect((await mkt.buyListing(C, priv!.id, buy(C, B, t, NET), okRelay())).ok).toBe(false);
    expect((await mkt.buyListing(A, priv!.id, buy(A, B, t, NET), okRelay())).ok).toBe(true);
    expect((await col.collectionOf(A)).copies.some((c) => c.uid === g.uid)).toBe(true);
    expect((await mkt.offersOf(A)).find((x) => x.id === o3.offer.id)?.state).toBe("paid");
    // cancel: open, and after it was accepted (the private sale closes)
    const o4 = await mkt.makeOffer(C, h.uid, 400);
    if (!o4.ok) throw new Error(o4.reason);
    expect((await mkt.answerOffer(B, o4.offer.id, "cancel")).ok).toBe(false);
    const a4 = await mkt.answerOffer(B, o4.offer.id, "accept");
    if (!a4.ok) throw new Error(a4.reason);
    expect((await mkt.answerOffer(C, o4.offer.id, "cancel")).ok).toBe(true);
    expect((await mkt.listingById(a4.offer.listing!))?.state).toBe("closed");
    expect((await mkt.listCopy(B, h.uid, 500)).ok).toBe(true);                    // the copy is free again
  });

  it("an accepted offer that isn't paid in time lapses and frees the copy; a copy that moves expires its offers", async () => {
    const { OFFER_PAY_MS } = await import("@/lib/market");
    await earn(B, 2);
    const [g, h] = await free(B);
    const t0 = Date.now();
    const o = await mkt.makeOffer(C, g.uid, 600, t0);
    if (!o.ok) throw new Error(o.reason);
    const acc = await mkt.answerOffer(B, o.offer.id, "accept", t0);
    if (!acc.ok) throw new Error(acc.reason);
    const later = t0 + OFFER_PAY_MS + 1000;
    expect("ok" in (await mkt.buyTerms(acc.offer.listing!, undefined, later))).toBe(true);
    expect((await mkt.offersOf(C, later)).find((x) => x.id === o.offer.id)?.state).toBe("lapsed");
    expect((await mkt.listingById(acc.offer.listing!, undefined, later))?.state).toBe("closed");
    expect((await mkt.listCopy(B, g.uid, 700)).ok).toBe(true);
    // an open offer on a copy that's since been sold to someone else reads as expired
    const o2 = await mkt.makeOffer(C, h.uid, 300);
    if (!o2.ok) throw new Error(o2.reason);
    const l = await mkt.listCopy(B, h.uid, 900);
    if (!l.ok) throw new Error(l.reason);
    const t = await mkt.buyTerms(l.listing.id);
    if ("ok" in t) throw new Error(t.reason);
    expect((await mkt.buyListing(A, l.listing.id, buy(A, B, t, NET), okRelay())).ok).toBe(true);
    expect((await mkt.offersOf(C)).find((x) => x.id === o2.offer.id)?.state).toBe("expired");
    expect((await mkt.answerOffer(B, o2.offer.id, "accept")).ok).toBe(false);
  });

  it("old item-for-item offers read as gone and can't be accepted", async () => {
    const s = kvMod.kv();
    await s.set(mkt.MKT.o("abcdefabcdef"), JSON.stringify({ id: "abcdefabcdef", from: A, to: B, give: ["x"], want: [], at: Date.now(), state: "open" }));
    await s.zadd(mkt.MKT.offers(B), [{ score: Date.now(), member: "abcdefabcdef" }]);
    expect((await mkt.offersOf(B)).some((x) => x.id === "abcdefabcdef")).toBe(false);
    expect((await mkt.answerOffer(B, "abcdefabcdef", "accept")).ok).toBe(false);
  });

  it("a frozen copy comes off the market and can't be listed or traded", async () => {
    const a = (await col.collectionOf(A)).copies.filter((c) => !c.bound && c.origin === "crate");
    const l = await mkt.listCopy(A, a[0].uid, 900);
    expect(l.ok).toBe(true);
    await mkt.freezeCopy(a[0].uid, "reported stolen");
    expect((await mkt.listings()).some((r) => r.uid === a[0].uid)).toBe(false);
    expect((await mkt.listCopy(A, a[0].uid, 900)).ok).toBe(false);
    expect((await mkt.makeOffer(B, a[0].uid, 500)).ok).toBe(false);
    await mkt.unfreezeCopy(a[0].uid);
    expect((await mkt.listCopy(A, a[0].uid, 900)).ok).toBe(true);
    void kvMod;
  });
  it("a frozen copy can't be traded up or scrapped, so it can't be laundered into a fresh copy", async () => {
    const { ITEMS, STARTER_SKIN, TRADE_UP_N } = await import("@/lib/collection");
    const s = kvMod.kv(), T = "0x" + "d4".repeat(20);
    const commons = ITEMS.filter((i) => i.series === 1 && i.rar === "common" && i.kind === "skin" && i.id !== STARTER_SKIN).slice(0, 1);
    await s.sadd(col.COLK.own(T), commons[0].id);
    const base = (await col.collectionOf(T)).copies.find((c) => c.origin === "migrated")!;
    const raw = JSON.parse((await s.get(col.COLK.inv(T)))!);
    for (let k = 1; k < TRADE_UP_N; k++) raw.push({ ...base, uid: `fz${String(k).padStart(14, "0")}`, serial: 800 + k });
    await s.set(col.COLK.inv(T), JSON.stringify(raw));
    const ten = (await col.collectionOf(T)).copies.filter((c) => c.origin === "migrated").map((c) => c.uid);
    expect(ten).toHaveLength(TRADE_UP_N);
    const real = base.uid;   // the one copy with a permanent record
    expect((await mkt.freezeCopy(real, "reported farmed")).ok).toBe(true);
    const tu = await col.tradeUp(T, ten);
    expect(tu.ok).toBe(false); if (!tu.ok) expect(tu.reason).toMatch(/frozen/);
    expect((await col.scrapCopy(T, real)).ok).toBe(false);
    expect((await col.collectionOf(T)).copies.filter((c) => c.origin === "migrated")).toHaveLength(TRADE_UP_N);   // nothing burned
    await mkt.unfreezeCopy(real);
    expect((await col.tradeUp(T, ten)).ok).toBe(true);
  });

  it("unlist and a buy can't both win: a pending sale can't be pulled, and a pulled listing can't be paid for", async () => {
    await earn(A, 3);
    const { XPK } = await import("@/lib/server/xp");
    const all = (await col.collectionOf(A)).copies.filter((c) => !c.bound && c.origin === "crate");
    const mine: typeof all = [];
    for (const c of all) if (!(await col.isListed(c.uid)) && !(await col.frozenReason(c.uid))) mine.push(c);
    // buy first: the listing is pending while the payment is in flight, and unlist refuses
    const l1 = await mkt.listCopy(A, mine[0].uid, 700);
    if (!l1.ok) throw new Error(l1.reason);
    const t1 = await mkt.buyTerms(l1.listing.id);
    if ("ok" in t1) throw new Error(t1.reason);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const paying = mkt.buyListing(B, l1.listing.id, buy(B, A, t1, BigInt(20_000)), deps(async () => { await gate; return { success: true, txHash: "0x1" }; }));
    for (let k = 0; k < 50 && (await mkt.listingById(l1.listing.id))?.state !== "pending"; k++) await new Promise((r) => setTimeout(r, 5));
    expect((await mkt.unlist(A, l1.listing.id)).ok).toBe(false);
    release();
    expect((await paying).ok).toBe(true);
    expect((await col.collectionOf(B)).copies.some((c) => c.uid === mine[0].uid)).toBe(true);
    // the seller holds the lock (unlisting): a buy that arrives now is refused and nothing is sent
    const l2 = await mkt.listCopy(A, mine[1].uid, 700);
    if (!l2.ok) throw new Error(l2.reason);
    const t2 = await mkt.buyTerms(l2.listing.id);
    if ("ok" in t2) throw new Error(t2.reason);
    await kvMod.kv().setNX(XPK.lock(A), "held", 10);
    let sent = 0;
    const r2 = await mkt.buyListing(C, l2.listing.id, buy(C, A, t2, BigInt(20_000)), deps(async () => { sent++; return { success: true }; }));
    expect(r2.ok).toBe(false); expect(sent).toBe(0);
    expect((await mkt.listingById(l2.listing.id))?.state).toBe("open");
    await kvMod.kv().del(XPK.lock(A));
    // the scanner's race: unlist has read the listing as open and is about to close it when a buy is admitted
    const s = kvMod.kv();
    let relayed = false, buying: Promise<unknown> | undefined;
    const sneaky = new Proxy(s, { get(target, k) {
      if (k !== "set") return (target as never)[k];
      return async (key: string, v: string, ...rest: unknown[]) => {
        if (!buying && key.endsWith(`:l:${l2.listing.id}`) && JSON.parse(v).state === "closed") {
          buying = mkt.buyListing(C, l2.listing.id, buy(C, A, t2, BigInt(20_000)), deps(async () => { relayed = true; return { success: true, txHash: "0x2" }; }));
          await buying;
        }
        return (target.set as (...a: unknown[]) => Promise<unknown>)(key, v, ...rest);
      };
    } });
    const un = await mkt.unlist(A, l2.listing.id, sneaky as typeof s);
    expect(buying).toBeDefined();
    const bought = (await buying) as { ok: boolean };
    // never both: if the buyer paid, the copy is theirs and the listing is sold, not closed under them
    expect(un.ok && bought.ok).toBe(false);
    expect(relayed).toBe(!un.ok);
    const after = await mkt.listingById(l2.listing.id);
    if (relayed) { expect(after?.state).toBe("sold"); expect((await col.collectionOf(C)).copies.some((c) => c.uid === mine[1].uid)).toBe(true); }
    else { expect(after?.state).toBe("closed"); expect((await col.collectionOf(A)).copies.some((c) => c.uid === mine[1].uid)).toBe(true); }
  });
});
