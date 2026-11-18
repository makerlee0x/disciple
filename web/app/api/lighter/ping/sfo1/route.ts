import { pingLighter } from "../handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1";
export const GET = () => pingLighter("sfo1");
