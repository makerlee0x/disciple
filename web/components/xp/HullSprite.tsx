"use client";
/**
 * The launch rocket in one hull grade (lib/rocketSkin SKINS id), with no nose coin: the Trophies rewards track and its
 * "Next unlock" card. Shows the chrome sprite until the grade is drawn.
 */
import { useEffect, useState } from "react";
import { BASE_ROCKET_HI_SRC, loadRocketSprite } from "@/lib/decal";
import { skinById, tintBase } from "@/lib/rocketSkin";

const cache = new Map<string, Promise<string>>();
function graded(id: string): Promise<string> {
  let p = cache.get(id);
  if (!p) {
    p = loadRocketSprite(BASE_ROCKET_HI_SRC).then((base) => tintBase(base, skinById(id), 1).toDataURL("image/png"));
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

export default function HullSprite({ hull, height, className }: { hull: string; height: number; className?: string }) {
  const [src, setSrc] = useState<string>(BASE_ROCKET_HI_SRC);
  useEffect(() => {
    let live = true;
    if (hull === "chrome") { setSrc(BASE_ROCKET_HI_SRC); return; }
    graded(hull).then((u) => { if (live) setSrc(u); }).catch(() => {});
    return () => { live = false; };
  }, [hull]);
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={className} style={{ height, width: Math.round((height * 221) / 609) }} />;
}
