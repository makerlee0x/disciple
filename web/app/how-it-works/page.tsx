/**
 * /how-it-works: PLACEHOLDER until the full "How it works" landing page is built. Reuses the first-visit modal's
 * approved steps (HowItWorksSteps) over the Launch Pad sky; the only extra copy is the back link.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { withBase } from "@/lib/base-path";
import HowItWorksSteps from "@/components/home/HowItWorksSteps";
import s from "./page.module.css";

export const metadata: Metadata = { title: "How DISCIPLE works" };

export default function HowItWorksPage() {
  return (
    <main className={s.page}>
      <div className={s.sky} style={{ backgroundImage: `url(${withBase("/home/sky/t0.webp")})` }} aria-hidden />
      <div className={s.wrap}>
        <Link href="/" className={s.back}>← Back to launchpad</Link>
        <h1 className={s.title}>How DISCIPLE works</h1>
        <HowItWorksSteps className={s.steps} />
      </div>
    </main>
  );
}
