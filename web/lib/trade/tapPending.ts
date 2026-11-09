/** Existing TradeBridge sent wire, explicitly pending: never a receipt/fill or account balance update. */
export function tapPending(pressId: string, side: "buy" | "sell", send: (e: Event) => unknown = dispatchEvent, clock = () => performance.now()) {
  const at = clock();
  send(new CustomEvent("disciple:op", { detail: { phase: "sent", stage: "tap", pending: true, pressId, side, at } }));
  return at;
}
