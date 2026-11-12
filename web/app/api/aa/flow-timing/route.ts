/** 4337 self-bundler flow-timing beacon. The path is removed; always 404. */
export const runtime = "nodejs";
export async function POST() { return new Response(null, { status: 404 }); }
