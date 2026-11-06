import "server-only";
/** Legacy streaming entry point: no protocol userOp submission or fallback. */
export function streamRelay(_params: unknown[], _settle: () => Promise<unknown>, _onError?: unknown, _beforeSend?: unknown): Response {
  void _params; void _settle; void _onError; void _beforeSend;
  return Response.json({ error: { code: -32601, message: "protocol relay disabled" } }, { status: 410 });
}
