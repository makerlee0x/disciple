export const runtime = "nodejs";
/**
 * Holder wallets (Solana for disciples, Ethereum for founder passes) linked to a profile wallet. lib/server/nft/holders.
 * GET  ?address=0x…&nonce=1  → { nonce, ttlSec }
 * GET  ?address=0x…          → HolderStatus { sol, eth, disciples, founders }
 * GET  ?address=0x…&owned=1  → { disciples: OwnedNft[] | null }  (null = couldn't check right now)
 * POST { address, action: "link", chain, wallet, walletSig, nonce, signature, owner? }
 *      walletSig = the holder wallet's signature over holderLinkMessage (Solana: base58 ed25519; Ethereum: 0x personal_sign);
 *      signature = the profile wallet's signature over the same message (same as /api/profile/meta).
 * POST { address, action: "unlink", chain, nonce, signature, owner? }  (profile signature over holderUnlinkMessage)
 */
import { NextResponse } from "next/server";
import { verifyMessage } from "viem";
import { kv } from "@/lib/server/kv";
import { consumeNonce, issueNonce, nonceValid } from "@/lib/server/nonces";
import { verifyWalletSignature } from "@/lib/server/chat/identity";
import { clientIp, hitLimit } from "@/lib/server/limits";
import { verifySolSignature } from "@/lib/server/nft/solSig";
import { holderStatus, linkWallet, linksOf, unlinkWallet } from "@/lib/server/nft/holders";
import { disciplesOf } from "@/lib/server/nft/chain";
import { holderLinkMessage, holderUnlinkMessage, isEvmAddress, isSolAddress, type HolderChain } from "@/lib/nft/config";

export const dynamic = "force-dynamic";
const NONCE_TTL = 600, PREFIX = "nft:nonce";
const j = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
const bad = (reason: string, status = 400) => j({ ok: false, reason }, status);

export async function GET(req: Request) {
  const u = new URL(req.url), address = (u.searchParams.get("address") || "").toLowerCase();
  if (!isEvmAddress(address)) return j({ error: "address required" }, 400);
  const rl = await hitLimit(kv(), `nft:get:ip:${clientIp(req.headers)}`, 60, 60);
  if (!rl.ok) return j({ error: "Too many requests, try again shortly." }, 429);
  if (u.searchParams.get("nonce") !== null) return j({ nonce: await issueNonce(kv(), PREFIX, address, NONCE_TTL), ttlSec: NONCE_TTL });
  if (u.searchParams.get("owned") !== null) {
    const l = await linksOf(address);
    return j({ disciples: l.sol ? await disciplesOf(l.sol) : [] });
  }
  return j(await holderStatus(address).catch(() => ({ sol: null, eth: null, disciples: 0, founders: 0 })));
}

export async function POST(req: Request) {
  const rl = await hitLimit(kv(), `nft:post:ip:${clientIp(req.headers)}`, 20, 60);
  if (!rl.ok) return bad("Too many requests, try again shortly.", 429);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return bad("Bad JSON"); }
  const addr = String(b?.address ?? "").toLowerCase();
  if (!isEvmAddress(addr)) return bad("Invalid address.");
  const chain = b.chain === "sol" || b.chain === "eth" ? (b.chain as HolderChain) : null;
  if (!chain) return bad("Unknown chain.");
  const nonce = String(b.nonce ?? "");
  if (!(await nonceValid(kv(), PREFIX, nonce, addr))) return bad("Sign-in expired. Try again.", 401);
  const owner = typeof b.owner === "string" ? b.owner : null;

  if (b.action === "unlink") {
    const who = await verifyWalletSignature(addr, holderUnlinkMessage(addr, chain, nonce), String(b.signature ?? ""), owner);
    if (who !== addr) return bad("Signature didn't match this wallet.", 401);
    if (!(await consumeNonce(kv(), PREFIX, nonce, addr))) return bad("Sign-in expired. Try again.", 401);
    await unlinkWallet(addr, chain);
    return j({ ok: true, status: await holderStatus(addr, true) });
  }
  if (b.action !== "link") return bad("Unknown action.");

  const wallet = String(b.wallet ?? "");
  if (chain === "sol" ? !isSolAddress(wallet) : !isEvmAddress(wallet)) return bad("Invalid wallet.");
  const msg = holderLinkMessage(addr, chain, wallet, nonce);
  const walletSig = String(b.walletSig ?? "");
  const walletOk = chain === "sol"
    ? verifySolSignature(wallet, msg, walletSig)
    : await verifyMessage({ address: wallet as `0x${string}`, message: msg, signature: walletSig as `0x${string}` }).catch(() => false);
  if (!walletOk) return bad("The wallet's signature didn't match.", 401);
  const who = await verifyWalletSignature(addr, msg, String(b.signature ?? ""), owner);
  if (who !== addr) return bad("Signature didn't match this wallet.", 401);
  if (!(await consumeNonce(kv(), PREFIX, nonce, addr))) return bad("Sign-in expired. Try again.", 401);
  await linkWallet(addr, chain, wallet);
  return j({ ok: true, status: await holderStatus(addr, true) });
}
