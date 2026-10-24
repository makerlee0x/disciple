// Signed profile meta (pfp / bio / flag) against a running server.   BASE_URL=http://localhost:3000 node scripts/test-profile-meta-api.mjs
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
const B = process.env.BASE_URL || "http://localhost:3000";
const msg = (a, m, n) => `DISCIPLE profile update\n\nWallet: ${a.toLowerCase()}\nPicture: ${m.pfp || "none"}\nFlag: ${m.flag || "none"}\nBio: ${m.bio || "none"}\nNonce: ${n}\n\nSigning proves you own this wallet. It costs nothing and sends no transaction.`;
let fail = 0; const ok = (c, m) => { if (!c) { fail++; console.error("FAIL " + m); } else console.log("ok  " + m); };
const acct = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
const a = acct.address.toLowerCase();
const nonce = async (addr) => (await (await fetch(`${B}/api/profile/meta?nonce=1&address=${addr}`)).json()).nonce;
const post = (b) => fetch(`${B}/api/profile/meta`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const m = { pfp: "", flag: "JP", bio: "flying high" };
let r = await post({ address: a, ...m }); ok(r.status === 401, "unsigned update rejected");
let n = await nonce(a);
r = await post({ address: a, ...m, nonce: n, signature: await other.signMessage({ message: msg(a, m, n) }) }); ok(r.status === 401, "wrong signer rejected");
const sig = await acct.signMessage({ message: msg(a, m, n) });
r = await post({ address: a, ...m, bio: "flying higher", nonce: n, signature: sig }); ok(r.status === 401, "signature bound to content");
r = await post({ address: a, ...m, flag: "XX", nonce: n, signature: sig }); ok(r.status === 400, "unknown flag rejected");
r = await post({ address: a, ...m, bio: " x\u202E ", nonce: n, signature: sig }); ok(r.status === 400, "non-canonical bio rejected");
r = await post({ address: a, ...m, bio: "x".repeat(161), nonce: n, signature: sig }); ok(r.status === 400, "long bio rejected");
r = await post({ address: a, ...m, nonce: n, signature: sig }); ok(r.status === 200, "signed update accepted");
r = await post({ address: a, ...m, nonce: n, signature: sig }); ok(r.status === 401, "nonce is single-use");
let g = await (await fetch(`${B}/api/profile/meta?address=${a}`)).json();
ok(g.flag === "JP" && g.bio === "flying high" && g.pfp === "" && g.pfpUrl === null, "read back");
n = await nonce(a); const p = { ...m, pfp: "0".repeat(64) };
r = await post({ address: a, ...p, nonce: n, signature: await acct.signMessage({ message: msg(a, p, n) }) });
ok(r.status === 400, "unmoderated / unknown picture id rejected");

// r2 (lee 2026-10-24): grapheme-counted bio with emoji + links, community flags, "no flag".
// Fresh wallet: the per-wallet write limit (10/min) is spent above.
const acct2 = privateKeyToAccount(generatePrivateKey()), a2 = acct2.address.toLowerCase();
const save = async (meta) => { const n2 = await nonce(a2); return post({ address: a2, ...meta, nonce: n2, signature: await acct2.signMessage({ message: msg(a2, meta, n2) }) }); };
r = await save({ pfp: "", flag: "c-pepe", bio: "👨‍👩‍👧".repeat(160) }); ok(r.status === 200, "160 ZWJ emoji + community flag accepted");
r = await save({ pfp: "", flag: "", bio: "👨‍👩‍👧".repeat(161) }); ok(r.status === 400, "161 graphemes rejected");
r = await save({ pfp: "", flag: "c-nope", bio: "" }); ok(r.status === 400, "unknown community flag rejected");
r = await save({ pfp: "", flag: "", bio: "gm https://x.com/disciple 🚀" }); ok(r.status === 200, "link + emoji bio, no flag accepted");
g = await (await fetch(`${B}/api/profile/meta?address=${a2}`)).json(); ok(g.flag === "" && g.bio === "gm https://x.com/disciple 🚀", "read back r2");

// Username: one change per 24h, enforced server-side.
const claimMsg = (u, addr, n3) => `DISCIPLE username claim\n\nUsername: @${u}\nWallet: ${addr}\nNonce: ${n3}\n\nSigning proves you own this wallet. It costs nothing and sends no transaction.`;
const unonce = async () => (await (await fetch(`${B}/api/profile/username?nonce=1&address=${a}`)).json()).nonce;
const claimU = async (u) => { const n3 = await unonce(); return fetch(`${B}/api/profile/username`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: u, address: a, nonce: n3, signature: await acct.signMessage({ message: claimMsg(u, a, n3) }) }) }); };
const base = "t" + a.slice(2, 12);
r = await claimU(base + "a"); ok(r.status === 200, "first username accepted");
let st = await (await fetch(`${B}/api/profile/username?address=${a}`)).json();
ok(st.username === base + "a" && st.nextAllowedAt > Date.now() + 23 * 3600e3, "first username starts the 24h clock");
r = await claimU(base + "a"); ok(r.status === 200, "re-claiming the same name is not a change");
r = await claimU(base + "b"); const j = await r.json();
ok(r.status === 429 && j.nextAllowedAt === st.nextAllowedAt && /24 hours/.test(j.reason), "rename within 24h rejected with nextAllowedAt");
st = await (await fetch(`${B}/api/profile/username?address=${a}`)).json(); ok(st.username === base + "a", "name unchanged after rejected rename");
process.exit(fail ? 1 : 0);
