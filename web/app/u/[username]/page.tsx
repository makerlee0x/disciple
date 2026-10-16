import PublicProfile from "./PublicProfile";
import { SAMPLE_USERNAMES } from "@/lib/mock/leaderboard";

/** Pre-render sample pilots for `output: 'export'`; the server build renders any username. */
export function generateStaticParams() {
  return SAMPLE_USERNAMES.map((username) => ({ username }));
}

export default function Page({ params }: { params: { username: string } }) {
  return <PublicProfile username={decodeURIComponent(params.username)} />;
}
