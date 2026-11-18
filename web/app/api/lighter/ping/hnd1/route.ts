import { pingLighter } from "../handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "hnd1";
export const GET = () => pingLighter("hnd1");
