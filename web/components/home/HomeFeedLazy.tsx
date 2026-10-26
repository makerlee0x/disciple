"use client";
/**
 * Lazy feed: the Launchpad bundle loads only after the hero has painted, on the
 * first of: page load + idle, or the placeholder nearing the viewport. The placeholder holds the feed's space (no CLS).
 */
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { HomeCoin } from "@/lib/home/trending";
import { afterPaint } from "./idle";
import s from "./appHome.module.css";

const HomeFeed = dynamic(() => import("./HomeFeed"), { ssr: false, loading: () => <FeedSkeleton /> });

function FeedSkeleton() {
  return (
    <div className={s.feedSkel} aria-hidden>
      <div className={s.feedSkelBar} />
      <div className={s.feedSkelGrid}>{Array.from({ length: 6 }, (_, i) => <i key={i} />)}</div>
    </div>
  );
}

export default function HomeFeedLazy({ initial }: { initial: HomeCoin[] }) {
  const [on, setOn] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (on) return;
    const cancel = afterPaint(() => setOn(true));
    const el = ref.current;
    const io = el ? new IntersectionObserver((e) => { if (e[0].isIntersecting) setOn(true); }, { rootMargin: "200px" }) : null;
    if (el && io) io.observe(el);
    return () => { cancel(); io?.disconnect(); };
  }, [on]);
  return (
    <main ref={ref} className={`lp-wrap ${s.feed}`} aria-label="Rockets">
      {on ? <HomeFeed initial={initial} /> : <FeedSkeleton />}
    </main>
  );
}
