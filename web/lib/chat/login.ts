/** The exact text signed for chat login (shared by client + server). */
export const chatLoginMessage = (addr: string, ts: number) =>
  `DISCIPLE live chat\n\nSign to chat as ${addr.toLowerCase()}.\nThis does not send a transaction.\n\nIssued: ${ts}`;
