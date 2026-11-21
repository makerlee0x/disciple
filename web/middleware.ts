import { NextResponse, type NextRequest } from "next/server";
import { isNativeAppUa } from "@/lib/native";

/**
 * The iPhone app gets its own home (app/app-home) at "/", so it skips the website lobby's HTML and JS. Only "/" runs this;
 * every other path never touches middleware.
 */
export const config = { matcher: ["/"] };

export function middleware(req: NextRequest) {
  if (!isNativeAppUa(req.headers.get("user-agent"))) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/app-home";
  return NextResponse.rewrite(url);
}
