/** Full diagnostic text, never credential-bearing URLs or signing/auth material. No raw error/op dumps. */
export function diagnosticText(value: unknown): string {
  return String(value ?? "")
    .replace(/https?:\/\/[^\s<>"'`]+/gi, "[URL redacted]")
    .replace(/Bearer\s+[^\s,"']+/gi, "Bearer [redacted]")
    .replace(/(["']?(?:privateKey|secret|accessToken|refreshToken|authorization|cookie|signature|paymasterData)["']?\s*[:=]\s*)(["'][^"']*["']|[^\s,}]+)/gi, "$1[redacted]");
}
/** Explicit allowlist: do not serialize providers, requests, calldata, session keys, or arbitrary error.data. */
export function errorDiagnostic(error: unknown): Record<string, string | number> & { message: string } {
  const e = error as { name?: string; code?: unknown; message?: string; details?: string; extra?: Record<string, unknown> } | null;
  const out: Record<string, string | number> & { message: string } = { message: diagnosticText(e?.message ?? error) };
  if (e?.name) out.name = diagnosticText(e.name);
  if (typeof e?.code === "string" || typeof e?.code === "number") out.code = diagnosticText(e.code);
  const detail = e?.extra?.detail ?? e?.details;
  if (detail) out.detail = diagnosticText(detail);
  for (const k of ["userOpHash", "txHash"] as const) {
    const v = e?.extra?.[k];
    if (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) out[k] = v;
  }
  const rpc = e?.extra?.rpcError as { code?: unknown; message?: unknown } | undefined;
  if (typeof rpc?.code === "number") out.rpcCode = rpc.code;
  if (rpc?.message) out.rpcMessage = diagnosticText(rpc.message);
  return out;
}
