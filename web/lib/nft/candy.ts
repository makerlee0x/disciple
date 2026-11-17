"use client";
/**
 * Candy Machine v3 calls for the rest of the Disciple drop (maker 2026-11-17: our own machine, same verified collection).
 *  - mintOne: the player's mint on /mint (0.777 SOL to DISCIPLE_TREASURY, 7 per wallet). No bot tax: a guard that fails
 *    (limit reached, sold out) fails the whole transaction in the wallet's preview, so nobody pays for a mint they didn't get.
 *  - createMachine / addLines: /admin/mint, signed by maker's wallet (the collection update authority). The machine
 *    holds config lines: name suffix (the disciple's number) + uri suffix ("181.json") under NAME_PREFIX / REVEALED_BASE.
 */
import { addConfigLines, create, createLutForCandyMachine, fetchCandyMachine, getCandyMachineSize, mintV2, safeFetchCandyGuard, safeFetchMintCounterFromSeeds } from "@metaplex-foundation/mpl-candy-machine";
import { TokenStandard } from "@metaplex-foundation/mpl-token-metadata";
import { fetchAddressLookupTable, setComputeUnitLimit, setComputeUnitPrice } from "@metaplex-foundation/mpl-toolbox";
import { generateSigner, percentAmount, publicKey, sol, some, transactionBuilder, type Umi } from "@metaplex-foundation/umi";
import { sendAllAndWait, sendAndWait } from "./umi";
import {
  DISCIPLE_COLLECTION, DISCIPLE_ROYALTY_BPS, DISCIPLE_RULE_SET, DISCIPLE_SYMBOL, DISCIPLE_TREASURY,
  MINT_LIMIT, MINT_LIMIT_ID, MINT_PRICE_SOL, NAME_PREFIX, REVEALED_BASE,
} from "./config";

const PRIORITY_MICRO_LAMPORTS = 50_000;
export const NAME_LEN = 3;   // "777"
export const URI_LEN = 8;    // "776.json"
export const LINES_PER_TX = 40;

export type MachineState = { itemsAvailable: number; itemsRedeemed: number; itemsLoaded: number; authority: string; price: number | null };
export async function readMachine(umi: Umi, cm: string): Promise<MachineState> {
  const m = await fetchCandyMachine(umi, publicKey(cm));
  const g = await safeFetchCandyGuard(umi, m.mintAuthority);
  const pay = g?.guards.solPayment;
  return {
    itemsAvailable: Number(m.data.itemsAvailable), itemsRedeemed: Number(m.itemsRedeemed), itemsLoaded: m.itemsLoaded,
    authority: m.authority.toString(), price: pay && pay.__option === "Some" ? Number(pay.value.lamports.basisPoints) / 1e9 : null,
  };
}

/** How many this wallet has minted from our machine (the 7 per wallet guard). */
export async function mintedBy(umi: Umi, cm: string, user: string): Promise<number> {
  const m = await fetchCandyMachine(umi, publicKey(cm));
  const c = await safeFetchMintCounterFromSeeds(umi, { id: MINT_LIMIT_ID, user: publicKey(user), candyMachine: m.publicKey, candyGuard: m.mintAuthority });
  return c?.count ?? 0;
}

/** Mint one disciple to the connected wallet. Resolves the new mint address. `lut` = the machine's lookup table. */
export async function mintOne(umi: Umi, cm: string, lut: string | null): Promise<{ mint: string; sig: string }> {
  const m = await fetchCandyMachine(umi, publicKey(cm));
  const nftMint = generateSigner(umi);
  const tables = lut ? [await fetchAddressLookupTable(umi, publicKey(lut))] : [];
  const b = transactionBuilder().setAddressLookupTables(tables)
    .add(setComputeUnitLimit(umi, { units: 800_000 }))
    .add(setComputeUnitPrice(umi, { microLamports: PRIORITY_MICRO_LAMPORTS }))
    .add(mintV2(umi, {
      candyMachine: m.publicKey, candyGuard: m.mintAuthority, nftMint,
      collectionMint: m.collectionMint, collectionUpdateAuthority: m.authority,
      tokenStandard: TokenStandard.ProgrammableNonFungible,
      ...(m.ruleSet.__option === "Some" ? { authorizationRules: m.ruleSet.value } : {}),
      mintArgs: { solPayment: some({ destination: publicKey(DISCIPLE_TREASURY) }), mintLimit: some({ id: MINT_LIMIT_ID }) },
    }));
  const sig = await sendAndWait(umi, b);
  return { mint: nftMint.publicKey.toString(), sig };
}

/** Create the machine + guards for `count` items. The connected wallet must be DISCIPLE_TREASURY. */
export async function createMachine(umi: Umi, count: number): Promise<string> {
  if (umi.identity.publicKey.toString() !== DISCIPLE_TREASURY) throw new Error(`Connect ${DISCIPLE_TREASURY.slice(0, 4)}…${DISCIPLE_TREASURY.slice(-4)}, the collection's wallet.`);
  const candyMachine = generateSigner(umi);
  const b = await create(umi, {
    candyMachine,
    collectionMint: publicKey(DISCIPLE_COLLECTION),
    collectionUpdateAuthority: umi.identity,
    tokenStandard: TokenStandard.ProgrammableNonFungible,
    ruleSet: publicKey(DISCIPLE_RULE_SET),
    sellerFeeBasisPoints: percentAmount(DISCIPLE_ROYALTY_BPS / 100, 2),
    symbol: DISCIPLE_SYMBOL,
    maxEditionSupply: 0,
    isMutable: true,
    creators: [{ address: publicKey(DISCIPLE_TREASURY), verified: true, percentageShare: 100 }],
    itemsAvailable: count,
    configLineSettings: some({ prefixName: NAME_PREFIX, nameLength: NAME_LEN, prefixUri: REVEALED_BASE, uriLength: URI_LEN, isSequential: false }),
    guards: {
      solPayment: some({ lamports: sol(MINT_PRICE_SOL), destination: publicKey(DISCIPLE_TREASURY) }),
      mintLimit: some({ id: MINT_LIMIT_ID, limit: MINT_LIMIT }),
    },
  });
  await sendAndWait(umi, transactionBuilder().add(setComputeUnitPrice(umi, { microLamports: PRIORITY_MICRO_LAMPORTS })).add(b));
  return candyMachine.publicKey.toString();
}

/** Lookup table with the machine's fixed accounts, so a pNFT mint fits in one transaction. Resolves its address. */
export async function createLut(umi: Umi, cm: string): Promise<string> {
  const slot = await umi.rpc.getSlot({ commitment: "finalized" });
  const [b, lut] = await createLutForCandyMachine(umi, slot, publicKey(cm), publicKey(DISCIPLE_TREASURY));
  await sendAndWait(umi, b);
  return lut.publicKey.toString();
}

/** SOL locked as rent in the machine account (comes back when the machine is closed). */
export async function machineRentSol(umi: Umi, count: number): Promise<number> {
  const size = getCandyMachineSize(count, some({ nameLength: NAME_LEN, uriLength: URI_LEN }), TokenStandard.ProgrammableNonFungible);
  return Number((await umi.rpc.getRent(size)).basisPoints) / 1e9;
}

/** one disciple left to mint: its number, which is also its file (REVEALED_BASE + "<n>.json") */
export type Line = { number: number };
/** Load every line from machine index `from` on: all batches in one wallet approval, sent in order. */
export async function addLines(umi: Umi, cm: string, from: number, lines: Line[], onBatch?: (loaded: number) => void): Promise<void> {
  const bs = [];
  for (let i = 0; i < lines.length; i += LINES_PER_TX) {
    const part = lines.slice(i, i + LINES_PER_TX);
    bs.push(transactionBuilder()
      .add(setComputeUnitPrice(umi, { microLamports: PRIORITY_MICRO_LAMPORTS }))
      .add(addConfigLines(umi, { candyMachine: publicKey(cm), index: from + i, configLines: part.map((l) => ({ name: String(l.number), uri: `${l.number}.json` })) })));
  }
  await sendAllAndWait(umi, bs, (k) => onBatch?.(Math.min(lines.length, (k + 1) * LINES_PER_TX)));
}
