/**
 * Map the UI's connected wallet to the address usernames and profile meta are stored under.
 *
 * Production keys the shared KV (`user:name:<name>` → wallet, `user:addr:<wallet>` → name) to the
 * Modular Account v2 address (counterfactual, derived from the owner). That is the standard
 * ERC-4337 pattern used by Account Kit / Alchemy, Safe, and Coinbase Smart Wallet: the EOA is only
 * the signer/owner; the app identity and on-chain address is the smart account. Profile writes
 * already sign as that account (ERC-1271 once deployed, ERC-6492 while counterfactual;
 * lib/profile.signWalletMessage → lib/aa/session.aaSignMessage, verified by lib/aa/verify.ts).
 *
 * On the gasless branch, `connectedAddress()` / `activeAddress()` are the Privy owner EOA (it holds
 * funds and signs Permit2 trades). If `connected` is that owner, return `smartAccount` so @names
 * resolve. Do not move KV keys onto the EOA. Other addresses are left unchanged.
 */
export function profileIdentityAddress(input: {
  connected?: string | null;
  smartAccount?: string | null;
  owner?: string | null;
}): string | null {
  const lc = (a?: string | null) => (a && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null);
  const smart = lc(input.smartAccount);
  const owner = lc(input.owner);
  const connected = lc(input.connected);
  if (smart && connected && (connected === owner || connected === smart)) return smart;
  return connected;
}
