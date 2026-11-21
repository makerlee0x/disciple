import { handleGaslessRpc } from "@/lib/server/gaslessRpc";
/** POST /api/gasless: see lib/server/gaslessRpc (shared with the always-on relay server, relay/server.ts). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: Request) => handleGaslessRpc(req);
