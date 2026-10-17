// Signed username claims against a running server.   BASE_URL=http://localhost:3000 node scripts/test-username-claim.mjs
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
const B = process.env.BASE_URL || "http://localhost:3000";
const msg = (u, a, n) => `DISCIPLE username claim\n\nUsername: @${u}\nWallet: ${a.toLowerCase()}\nNonce: ${n}\n\nSigning proves you own this wallet. It costs nothing and sends no transaction.`;
let fail = 0; const ok = (c, m) => { if (!c) { fail++; console.error("FAIL " + m); } else console.log("ok  " + m); };
const acct = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
const a = acct.address.toLowerCase(), u = "t" + Math.random().toString(36).slice(2, 10);
const nonce = async (addr) => (await (await fetch(`${B}/api/profile/username?nonce=1&address=${addr}`)).json()).nonce;
const post = (b) => fetch(`${B}/api/profile/username`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
let r = await post({ username: u, address: a }); ok(r.status === 401, "unsigned claim rejected");
let n = await nonce(a); r = await post({ username: u, address: a, nonce: n, signature: await other.signMessage({ message: msg(u, a, n) }) }); ok(r.status === 401, "wrong signer rejected");
await nonce(a); await nonce(a); // anyone can request nonces for `a`: must not delete/overwrite the pending one (W-3)
const goodSig = await acct.signMessage({ message: msg(u, a, n) });
r = await post({ username: u, address: a, nonce: n, signature: goodSig }); ok(r.status === 200, "signed claim accepted (pending nonce survived other GETs)");
r = await post({ username: u, address: a, nonce: n, signature: goodSig }); ok(r.status === 401, "nonce is single-use (replay rejected)");
r = await post({ username: u, address: other.address.toLowerCase(), nonce: n, signature: goodSig }); ok(r.status === 401, "nonce bound to its address");
ok((await (await fetch(`${B}/api/profile/username?resolve=${u}`)).json()).address === a, "reverse lookup");
const b = other.address.toLowerCase(); n = await nonce(b);
r = await post({ username: u, address: b, nonce: n, signature: await other.signMessage({ message: msg(u, b, n) }) }); ok(r.status === 409, "taken by another wallet");
process.exit(fail ? 1 : 0);
