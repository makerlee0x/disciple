/**
 * A coin's own rocket on a card (lib/coinLook): the Hangar skin its host picked at launch, sized to the card's rocket box
 * (a wide hull is a little shorter), with the coin's badge on the hull's badge spot. No look (or classic) = the chrome rocket
 * with the badge on its body, like the launch pad.
 */
import { withBase } from "@/lib/base-path";
import { lookArt, lookFilter, type CoinLook } from "@/lib/coinLook";
import { isStoreSrc } from "@/lib/coinImages";
import { ROCKET_SRC } from "@/lib/home/trending";
import s from "./coinRocket.module.css";

export default function CoinRocket({ look, icon, className }: { look?: CoinLook | null; icon?: string; className?: string }) {
  const a = lookArt(look);
  const src = a.src ?? ROCKET_SRC;
  const k = Math.min(1, Math.sqrt(0.45 / a.aspect));
  return (
    <span className={`${s.box}${className ? " " + className : ""}`} aria-hidden data-look={look?.skin ?? "classic"}>
      <span className={s.ship} style={{ height: `${k * 100}%`, aspectRatio: String(a.aspect) }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={withBase(src)} alt="" loading="lazy" decoding="async" style={{ filter: lookFilter(look) }} />
        {icon && isStoreSrc(icon) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className={s.badge} src={icon} alt="" loading="lazy" decoding="async"
            style={{ left: `${a.badge[0] * 100}%`, top: `${a.badge[1] * 100}%`, width: `${a.badge[2] * 200}%` }} />
        ) : null}
      </span>
    </span>
  );
}
