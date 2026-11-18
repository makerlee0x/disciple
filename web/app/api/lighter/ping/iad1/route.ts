import { pingLighter } from "../handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "iad1";
export const GET = () => pingLighter("iad1");
