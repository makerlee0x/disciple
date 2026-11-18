import { pingLighter } from "../handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "fra1";
export const GET = () => pingLighter("fra1");
