import { pingLighter } from "../handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";
export const GET = () => pingLighter("sin1");
