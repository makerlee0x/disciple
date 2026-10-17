/**
 * The exact text signed for chat login (shared by client + server). `nonce` is a single-use server nonce from
 * GET /api/chat/auth?addr= (W-3: a captured signature can't be replayed; the server deletes the nonce on use).
 */
export const chatLoginMessage = (addr: string, ts: number, nonce: string) =>
  `DISCIPLE live chat\n\nSign to chat as ${addr.toLowerCase()}.\nThis does not send a transaction.\n\nIssued: ${ts}\nNonce: ${nonce}`;
