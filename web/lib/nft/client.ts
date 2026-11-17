"use client";
/** Client side of /api/nft/* (holder wallets, NFT pictures, founder passes, mint status). */
import { withBase } from "../base-path";
import { notifyProfileChanged, signWalletMessage } from "../profile";
import { holderLinkMessage, holderUnlinkMessage, type HolderChain, type HolderStatus, type OwnedNft } from "./config";

export const EMPTY_HOLDER: HolderStatus = { sol: null, eth: null, disciples: 0, founders: 0 };
const api = (p: string) => withBase(p);

export async function fetchHolder(profile: string | null): Promise<HolderStatus> {
  if (!profile) return EMPTY_HOLDER;
  try { return { ...EMPTY_HOLDER, ...(await (await fetch(api(`/api/nft/link?address=${profile.toLowerCase()}`), { cache: "no-store" })).json()) }; }
  catch { return EMPTY_HOLDER; }
}
/** Disciples in the profile's linked Solana wallet. null = couldn't check right now. */
export async function fetchOwned(profile: string): Promise<OwnedNft[] | null> {
  try { return ((await (await fetch(api(`/api/nft/link?owned=1&address=${profile.toLowerCase()}`), { cache: "no-store" })).json()) as { disciples: OwnedNft[] | null }).disciples; }
  catch { return null; }
}

async function nonceFor(profile: string): Promise<string | null> {
  try { return ((await (await fetch(api(`/api/nft/link?nonce=1&address=${profile}`), { cache: "no-store" })).json()) as { nonce?: string }).nonce ?? null; }
  catch { return null; }
}
type Res = { ok: boolean; reason?: string; status?: HolderStatus };
async function post(body: Record<string, unknown>): Promise<Res> {
  try {
    const r = await fetch(api("/api/nft/link"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as Res;
    if (r.ok && j.ok) { notifyProfileChanged(); return j; }
    return { ok: false, reason: j.reason || "Couldn't link that wallet." };
  } catch { return { ok: false, reason: "Couldn't reach the server." }; }
}

/** Link a holder wallet: the holder wallet signs, then the profile wallet signs the same message. */
export async function linkHolder(profile: string, chain: HolderChain, wallet: string, signWithHolder: (msg: string) => Promise<string>): Promise<Res> {
  const p = profile.toLowerCase(), nonce = await nonceFor(p);
  if (!nonce) return { ok: false, reason: "Couldn't reach the server." };
  const msg = holderLinkMessage(p, chain, wallet, nonce);
  let walletSig: string;
  try { walletSig = await signWithHolder(msg); } catch { return { ok: false, reason: "Signature declined." }; }
  const signed = await signWalletMessage(msg, p);
  if (!signed) return { ok: false, reason: "Signature declined." };
  return post({ address: p, action: "link", chain, wallet, walletSig, nonce, ...signed });
}
export async function unlinkHolder(profile: string, chain: HolderChain): Promise<Res> {
  const p = profile.toLowerCase(), nonce = await nonceFor(p);
  if (!nonce) return { ok: false, reason: "Couldn't reach the server." };
  const signed = await signWalletMessage(holderUnlinkMessage(p, chain, nonce), p);
  if (!signed) return { ok: false, reason: "Signature declined." };
  return post({ address: p, action: "unlink", chain, nonce, ...signed });
}

/** Copy a disciple's art in as a picture; resolves the stored image id to put in the profile draft. */
export async function pickNftPfp(profile: string, id: string): Promise<{ imageId?: string; reason?: string }> {
  try {
    const r = await fetch(api("/api/nft/pfp"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: profile.toLowerCase(), id }) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; imageId?: string; reason?: string };
    return j.ok && j.imageId ? { imageId: j.imageId } : { reason: j.reason || "Couldn't use that NFT." };
  } catch { return { reason: "Couldn't reach the server." }; }
}

export type MintStatus = { supply: number; minted: number | null; price: number; limit: number; candyMachine: string | null; lut: string | null };
export async function fetchMintStatus(): Promise<MintStatus | null> {
  try { return await (await fetch(api("/api/nft/mint"), { cache: "no-store" })).json(); } catch { return null; }
}

export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
