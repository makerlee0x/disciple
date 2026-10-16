/** Username claim message (signed by the wallet; verified in /api/profile/username). Shared client/server. */
export const claimMessage = (username: string, address: string, nonce: string) =>
  `DISCIPLE username claim\n\nUsername: @${username}\nWallet: ${address.toLowerCase()}\nNonce: ${nonce}\n\nSigning proves you own this wallet. It costs nothing and sends no transaction.`;
