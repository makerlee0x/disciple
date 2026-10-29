import PublicProfile from "./PublicProfile";

/**
 * The server build renders any username on demand. `output: 'export'` (STATIC_PREVIEW=1) needs at least one
 * pre-rendered path, so the static preview gets a single placeholder slug; no sample pilots are pre-rendered.
 */
export function generateStaticParams() {
  return process.env.STATIC_PREVIEW === "1" ? [{ username: "pilot" }] : [];
}

export default function Page({ params }: { params: { username: string } }) {
  return <PublicProfile username={decodeURIComponent(params.username)} />;
}
