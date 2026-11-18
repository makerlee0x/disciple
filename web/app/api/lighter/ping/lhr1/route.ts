import { pingLighter } from "../handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "lhr1";
export const GET = () => pingLighter("lhr1");
