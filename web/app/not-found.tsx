import Link from "next/link";
import LostSky, { LostRocket } from "@/components/LostSky";

export const LOST_COPY = {
  eyebrow: "404 · Off course",
  title: "This link drifted out of range",
  body: "There's no rocket or page here. The link may be old, or mistyped.",
  home: "Back to the Lobby",
  launch: "Launch a rocket",
} as const;

export default function NotFound() {
  const C = LOST_COPY;
  return (
    <LostSky art={<LostRocket />} eyebrow={C.eyebrow} title={C.title} body={C.body} testId="not-found">
      <Link href="/" className="r2-gold ls-gold">{C.home}</Link>
      <Link href="/create" className="r2-btn ls-btn">{C.launch}</Link>
    </LostSky>
  );
}
