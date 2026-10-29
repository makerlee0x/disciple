/**
 * GAME's import path for SITE's in-flight reservation registry (lib/trade/reservations, #144). The shim was a verbatim
 * copy while #144 was out of the stack; it is the registry now, so GAME and the trade layer share ONE instance.
 */
export * from "@/lib/trade/reservations";
