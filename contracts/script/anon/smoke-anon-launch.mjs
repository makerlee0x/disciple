import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, keccak256, toHex, hexToBigInt, concat, pad, numberToHex, getAddress, parseEther, decodeEventLog } from 'viem';
import { privateKeyToAccount, publicKeyToAddress, generatePrivateKey } from 'viem/accounts';
import { secp256k1 } from '@noble/curves/secp256k1';
import fs from 'fs';

const chain = { id: 46630, name: 'rh-testnet', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } } };
const pc = createPublicClient({ chain, transport: http() });
const BUNDLER = `https://robinhood-testnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const POLICY = process.env.ALCHEMY_GAS_POLICY_ID;
const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const FACTORY = '0x0000000000400CdFef5E2714E63d8040b700BC24';
const ANON = '0x722a7927B5496b10C58e50628ab7787f1Eec0696';
const USDG = '0x25030Bff74764aD72b912276a603717DB1C00644';
const out = { userOps: [] };
const log = (...a) => console.log(...a);

async function rpc(method, params) {
  const r = await fetch(BUNDLER, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error));
  return j.result;
}
const facAbi = parseAbi(['function createAccount(address owner, uint256 salt) returns (address)', 'function getAddress(address owner, uint256 salt) view returns (address)']);
const acctAbi = parseAbi(['function execute(address dest, uint256 value, bytes func)', 'function executeBatch(address[] dest, uint256[] value, bytes[] func)']);
const epAbi = parseAbi(['function getNonce(address sender, uint192 key) view returns (uint256)']);
const erc20 = parseAbi(['function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const anonAbi = JSON.parse(fs.readFileSync('/workspace/disciple-anon/contracts/out/AnonLauncher.sol/AnonLauncher.json')).abi;

function packUint(hi, lo) { return pad(numberToHex((BigInt(hi) << 128n) | BigInt(lo)), { size: 32 }); }
function userOpHash(op) {
  const initCode = op.factory ? concat([op.factory, op.factoryData]) : '0x';
  const pmd = op.paymaster ? concat([op.paymaster, pad(op.paymasterVerificationGasLimit, { size: 16 }), pad(op.paymasterPostOpGasLimit, { size: 16 }), op.paymasterData]) : '0x';
  const { encodeAbiParameters } = await_import;
  const inner = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [op.sender, BigInt(op.nonce), keccak256(initCode), keccak256(op.callData), packUint(op.verificationGasLimit, op.callGasLimit), BigInt(op.preVerificationGas), packUint(op.maxPriorityFeePerGas, op.maxFeePerGas), keccak256(pmd)]));
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }], [inner, EP, 46630n]));
}
let await_import;

async function sendSponsored(ownerAcct, salt, callData, label) {
  const sender = await pc.readContract({ address: FACTORY, abi: facAbi, functionName: 'getAddress', args: [ownerAcct.address, salt] });
  const code = await pc.getCode({ address: sender });
  const nonce = await pc.readContract({ address: EP, abi: epAbi, functionName: 'getNonce', args: [sender, 0n] });
  const op = { sender, nonce: numberToHex(nonce), callData };
  if (!code || code === '0x') { op.factory = FACTORY; op.factoryData = encodeFunctionData({ abi: facAbi, functionName: 'createAccount', args: [ownerAcct.address, salt] }); }
  const dummy = concat(['0x00', await privateKeyToAccount(generatePrivateKey()).signMessage({ message: 'dummy' })]);
  if (process.env.SELF_PAY) {
    const blk = await pc.getBlock();
    const prio = BigInt(await rpc('rundler_maxPriorityFeePerGas', []));
    op.maxPriorityFeePerGas = numberToHex(prio);
    op.maxFeePerGas = numberToHex(blk.baseFeePerGas * 2n + prio);
    op.signature = dummy;
    const est = await rpc('eth_estimateUserOperationGas', [op, EP]);
    op.callGasLimit = est.callGasLimit; op.verificationGasLimit = est.verificationGasLimit;
    op.preVerificationGas = numberToHex(BigInt(est.preVerificationGas) * 12n / 10n);
  } else {
    const res = await rpc('alchemy_requestGasAndPaymasterAndData', [{ policyId: POLICY, entryPoint: EP, dummySignature: dummy, userOperation: op }]);
    Object.assign(op, res);
  }
  const h = userOpHash(op);
  const sig = await ownerAcct.signMessage({ message: { raw: h } });
  op.signature = concat(['0x00', sig]);
  const uoh = await rpc('eth_sendUserOperation', [op, EP]);
  log(label, 'userOpHash', uoh, 'paymaster', op.paymaster);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const rc = await rpc('eth_getUserOperationReceipt', [uoh]);
    if (rc) {
      log(label, 'tx', rc.receipt.transactionHash, 'success', rc.success, 'actualGasCost', rc.actualGasCost, 'paymaster', rc.paymaster);
      out.userOps.push({ label, sender, userOpHash: uoh, tx: rc.receipt.transactionHash, success: rc.success, paymaster: rc.paymaster, actualGasCost: rc.actualGasCost });
      return { rc, sender };
    }
  }
  throw new Error('timeout ' + uoh);
}

// ERC-5564 scheme 1 (secp256k1) stealth address
function genStealth(spendPub, viewPub) {
  const eph = secp256k1.utils.randomPrivateKey();
  const ephPub = secp256k1.getPublicKey(eph, true);
  const shared = secp256k1.getSharedSecret(eph, viewPub, true);
  const hs = keccak256(toHex(shared));
  const viewTag = hs.slice(0, 4);
  const P = secp256k1.ProjectivePoint.fromHex(spendPub).add(secp256k1.ProjectivePoint.BASE.multiply(hexToBigInt(hs) % secp256k1.CURVE.n));
  const addr = publicKeyToAddress(toHex(P.toRawBytes(false)));
  return { addr, ephPub: toHex(ephPub), viewTag };
}
function recoverStealthKey(spendPriv, viewPriv, ephPub) {
  const shared = secp256k1.getSharedSecret(viewPriv.slice(2), ephPub.slice(2), true);
  const hs = keccak256(toHex(shared));
  const k = (hexToBigInt(spendPriv) + hexToBigInt(hs)) % secp256k1.CURVE.n;
  return pad(numberToHex(k), { size: 32 });
}

async function main() {
  await_import = await import('viem');
  const main = privateKeyToAccount(process.env.CREATOR_PRIVATE_KEY); // "main wallet" (owner of the smart account)
  const relayerOwner = privateKeyToAccount(process.env.PRIVATE_KEY);
  // recipient's stealth meta-address (spend/view keys; client-side, never on-chain)
  const spendPriv = generatePrivateKey(), viewPriv = generatePrivateKey();
  const spendPub = secp256k1.getPublicKey(spendPriv.slice(2), true), viewPub = secp256k1.getPublicKey(viewPriv.slice(2), true);
  const salt = process.env.SALT ? BigInt(process.env.SALT) : BigInt(Date.now()); log("salt", salt);
  const sa = await pc.readContract({ address: FACTORY, abi: facAbi, functionName: 'getAddress', args: [main.address, salt] });
  log('smart account', sa);
  // fund SA with USDG (main EOA -> SA; this is the remaining payer link)
  const wc = createWalletClient({ chain, transport: http(), account: main });
  const usdgBal = await pc.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [sa] });
  const ft = usdgBal >= parseEther('11') ? null : await wc.writeContract({ address: USDG, abi: erc20, functionName: 'transfer', args: [sa, parseEther('20')] });
  if (ft) await pc.waitForTransactionReceipt({ hash: ft });
  if (process.env.SELF_PAY) {
    const dw = createWalletClient({ chain, transport: http(), account: relayerOwner });
    const relSa = await pc.readContract({ address: FACTORY, abi: facAbi, functionName: 'getAddress', args: [relayerOwner.address, 1n] });
    for (const a of [sa, relSa]) { if ((await pc.getBalance({ address: a })) >= parseEther('0.0001')) continue; const h = await dw.sendTransaction({ to: a, value: parseEther('0.0002') }); await pc.waitForTransactionReceipt({ hash: h }); out['ethFund_' + a] = h; log('eth fund', a, h); }
  }
  out.fundTx = ft; log('fund tx', ft);

  const coins = [], stealths = [];
  for (let i = 0; i < 2; i++) {
    const st = genStealth(spendPub, viewPub);
    const fresh = privateKeyToAccount(generatePrivateKey()).address;
    const params = { name: `Pseudo${i}`, ticker: `PSD${i}`, imageURI: 'ipfs://anon', description: 'pseudonymous launch smoke', socialsURI: '', quote: USDG, creatorTaxBps: 0n, creatorBuyQuoteIn: parseEther('5'), creatorBuyMinTokensOut: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) };
    const cd = encodeFunctionData({ abi: acctAbi, functionName: 'executeBatch', args: [[USDG, ANON], [0n, 0n], [
      encodeFunctionData({ abi: erc20, functionName: 'approve', args: [ANON, parseEther('5.25')] }),
      encodeFunctionData({ abi: anonAbi, functionName: 'launchAnon', args: [params, st.addr, fresh, st.ephPub, st.viewTag, await pc.readContract({ address: ANON, abi: anonAbi, functionName: 'launchFee' })] })]] });
    const { rc } = await sendSponsored(main, salt, cd, `launch${i}`);
    let token;
    for (const l of rc.logs) { try { const ev = decodeEventLog({ abi: anonAbi, data: l.data, topics: l.topics }); if (ev.eventName === 'AnonLaunched') token = ev.args.token; } catch {} }
    log('token', token, 'stealth', st.addr, 'fresh', fresh);
    coins.push(token); stealths.push(st);
  }
  out.coins = coins; out.stealths = stealths.map(s => s.addr);
  // Relayed batch claim: each coin has its own stealth owner -> one ClaimReq per owner, batched in one tx.
  const dest = privateKeyToAccount(generatePrivateKey()).address;
  const reqs = [];
  for (let i = 0; i < coins.length; i++) {
    const sk = recoverStealthKey(spendPriv, viewPriv, stealths[i].ephPub);
    const acct = privateKeyToAccount(sk);
    if (acct.address !== stealths[i].addr) throw new Error('stealth key mismatch');
    const nonce = await pc.readContract({ address: ANON, abi: anonAbi, functionName: 'nonces', args: [acct.address] });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const sig = await acct.signTypedData({ domain: { name: 'DISCIPLE AnonLauncher', version: '1', chainId: 46630, verifyingContract: ANON },
      types: { Claim: [{ name: 'owner', type: 'address' }, { name: 'tokens', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'relayerFeeBps', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      primaryType: 'Claim', message: { owner: acct.address, tokens: [coins[i]], to: dest, relayerFeeBps: 0n, nonce, deadline } });
    reqs.push({ owner: acct.address, tokens: [coins[i]], to: dest, relayerFeeBps: 0n, deadline, sig });
  }
  const pend = await Promise.all(coins.map(c => pc.readContract({ address: ANON, abi: anonAbi, functionName: 'pending', args: [c] })));
  log('pending', pend.map(p => p[1].toString()));
  const cd = encodeFunctionData({ abi: acctAbi, functionName: 'execute', args: [ANON, 0n, encodeFunctionData({ abi: anonAbi, functionName: 'claimManyBySigBatch', args: [reqs] })] });
  await sendSponsored(relayerOwner, 1n, cd, 'claimBatch');
  const bal = await pc.readContract({ address: USDG, abi: erc20, functionName: 'balanceOf', args: [dest] });
  out.claimDest = dest; out.claimedUSDG = bal.toString(); out.pending = pend.map(p => p[1].toString());
  log('dest', dest, 'received', bal.toString());
  fs.writeFileSync('/workspace/anon-smoke/result.json', JSON.stringify(out, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
}
main().catch(e => { console.error('ERR', e.message); fs.writeFileSync('/workspace/anon-smoke/result.json', JSON.stringify(out, null, 2)); process.exit(1); });
