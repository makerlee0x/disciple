import { pingLighter } from "../handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "icn1";
export const GET = () => pingLighter("icn1");
