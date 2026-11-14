import { withBase } from "@/lib/base-path";

/* Speed pass (2026-11-14): the Free play hub renders client-side (the page reads its search params), so its largest paint, the
   daily card's sky (freePlay.module.css .dailyArt), was only found after the JS ran and the CSS was parsed. This hint fetches
   it with the page. React hoists the <link> into <head>. */
export default function FreePlayLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link rel="preload" as="image" href={withBase("/home/sky/t3.webp")} fetchPriority="high" />
      {children}
    </>
  );
}
