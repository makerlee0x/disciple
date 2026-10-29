/**
 * Sample data is local-dev only (lee, Oct 26 2026: "pull all sample data off prod").
 * `devSample()` is true only in `next dev` (NODE_ENV === "development") AND with `?sample=1` in the URL. Next inlines
 * NODE_ENV at build time, so callers write `process.env.NODE_ENV === "development" && devSample()` inline in front of
 * every `import("@/lib/mock/…")`: in a production build that branch (and the mock chunk) is dropped from the bundle.
 */
export function devSample(): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("sample") === "1";
}
