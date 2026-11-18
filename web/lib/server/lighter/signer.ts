import "server-only";
/**
 * Lighter's own transaction signer (lighter-go compiled to WebAssembly; rebuild with tools/lighter/build-signer.sh),
 * loaded once per server instance. Every Sign* call is synchronous and offline: it only needs the player's Lighter API
 * key, which lives encrypted in KV (./keys.ts).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";

export interface SignResult { error?: string; txType: number; txInfo: string; txHash?: string; messageToSign?: string }
interface Wasm {
  GenerateAPIKey(): { privateKey: string; publicKey: string; error?: string };
  CreateClient(url: string, priv: string, chainId: number, apiKeyIndex: number, accountIndex: number): { error?: string };
  CreateAuthToken(deadlineSec: number, apiKeyIndex: number, accountIndex: number): { authToken?: string; error?: string };
  SignChangePubKey(pub: string, skipNonce: number, nonce: number, apiKeyIndex: number, accountIndex: number): SignResult;
  SignCreateOrder(...a: number[]): SignResult;
  /** Disciple patch (tools/lighter/build-signer.sh): ExpiredAt (ms) for the next SignCreateOrder calls; 0 = 10 min default. */
  SetOrderTxExpiry(ms: number): object;
  SignUpdateLeverage(market: number, fraction: number, marginMode: number, skipNonce: number, nonce: number, apiKeyIndex: number, accountIndex: number): SignResult;
  /** a transfer to another Lighter account (fast withdrawal = transfer to the pool); fee is charged on top. Needs the owner's L1 signature. */
  SignTransfer(toAccountIndex: number, assetIndex: number, fromRouteType: number, toRouteType: number, amount: number, usdcFee: number, memo: string, skipNonce: number, nonce: number, apiKeyIndex: number, accountIndex: number): SignResult;
  SignApproveIntegrator(integrator: number, maxPerpsTaker: number, maxPerpsMaker: number, maxSpotTaker: number, maxSpotMaker: number, expiryMs: number, skipNonce: number, nonce: number, apiKeyIndex: number, accountIndex: number): SignResult;
}

const DIR = path.join(process.cwd(), "lib/server/lighter/signer");
let loading: Promise<Wasm> | null = null;

export function signer(): Promise<Wasm> {
  loading ??= (async () => {
    const g = globalThis as unknown as Wasm & { Go?: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> } };
    if (!g.Go) vm.runInThisContext(fs.readFileSync(path.join(DIR, "wasm_exec.js"), "utf8"), { filename: "wasm_exec.js" });
    const go = new g.Go!();
    const bytes = zlib.gunzipSync(fs.readFileSync(path.join(DIR, "lighter-signer.wasm.gz")));
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    void go.run(instance); // the Go program stays alive and registers the Sign* globals
    return g;
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

/** Binds the player's key to the signer for (apiKeyIndex, accountIndex); call before each Sign*. */
export async function signerFor(privateKey: string, chainId: number, apiKeyIndex: number, accountIndex: number) {
  const w = await signer();
  const r = w.CreateClient("", privateKey, chainId, apiKeyIndex, accountIndex);
  if (r?.error) throw new Error(`lighter signer: ${r.error}`);
  return w;
}

export function checked(r: SignResult): SignResult {
  if (r.error) throw new Error(`lighter sign: ${r.error}`);
  return r;
}
