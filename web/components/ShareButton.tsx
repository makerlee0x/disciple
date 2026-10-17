"use client";

import { useState } from "react";
import { fmtUsd, nextUnlock } from "@/lib/config";
import { brandedRocket } from "@/lib/decal";
import { gateFlightIcon } from "@/lib/flight/iconGate";
import Icon from "@/components/icons/Icon";

type FlightWin = {
  __flight?: { S?: { confirmed?: { mcap?: number | null } } };
  __rocketDecal?: { canvas: HTMLCanvasElement };
};

/** Exports a 1200×630 PNG share card: branded rocket, call sign, tier, $ market cap. */
export async function renderShareCard(callSign: string, icon?: string | null): Promise<Blob> {
  const w = window as unknown as FlightWin;
  const rocket = w.__rocketDecal?.canvas || (await brandedRocket(gateFlightIcon(icon))).canvas;   // AUDIT: moderated store only
  const mcap = w.__flight?.S?.confirmed?.mcap ?? 0;
  const tier = nextUnlock(mcap).current;
  const c = document.createElement("canvas"); c.width = 1200; c.height = 630;
  const g = c.getContext("2d")!;
  const bg = g.createLinearGradient(0, 0, 0, 630); bg.addColorStop(0, "#16181C"); bg.addColorStop(1, "#1F2228");
  g.fillStyle = bg; g.fillRect(0, 0, 1200, 630);
  const glow = g.createRadialGradient(330, 330, 0, 330, 330, 300); glow.addColorStop(0, "rgba(201,206,214,.35)"); glow.addColorStop(1, "rgba(201,206,214,0)");
  g.fillStyle = glow; g.fillRect(0, 0, 700, 630);
  const h = 540, rw = (h * rocket.width) / rocket.height;
  g.save(); g.translate(330, 590); g.rotate(0.18); g.drawImage(rocket, -rw / 2, -h, rw, h); g.restore();
  g.fillStyle = "#C9CED6"; g.font = "bold 28px ui-monospace,monospace"; g.fillText("CALL SIGN", 620, 170);
  g.fillStyle = "#E8EAEE"; g.font = "bold 96px Georgia,serif"; g.fillText(callSign, 620, 270);
  g.fillStyle = "#C9CED6"; g.font = "bold 30px ui-monospace,monospace"; g.fillText("TIER · " + tier, 620, 350);
  g.fillStyle = "#ffffff"; g.font = "bold 72px ui-monospace,monospace"; g.fillText(fmtUsd(mcap), 620, 450);
  g.fillStyle = "rgba(232,234,238,.7)"; g.font = "24px ui-monospace,monospace"; g.fillText("Board my rocket on DISCIPLE · disciple.vip", 620, 540);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
}

export default function ShareButton({ callSign, icon }: { callSign: string; icon?: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  async function onShare() {
    const blob = await renderShareCard(callSign, icon);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    const a = document.createElement("a");
    a.href = u; a.download = `disciple-${callSign}.png`; a.click();
  }
  return (
    <>
      <button type="button" onClick={onShare} aria-label="Share rocket card"
        style={{ position: "fixed", top: "var(--ap-tr-top, 12px)", right: 60, zIndex: 35, height: 38, padding: "0 14px", borderRadius: 19,
          color: "#E8EAEE", background: "rgba(22,24,28,.82)", border: "1px solid rgba(201,206,214,.7)", font: "bold 12px ui-monospace,monospace", cursor: "pointer" }}>
        <Icon name="share" size={16} style={{ verticalAlign: -3 }} /> SHARE
      </button>
      {url && (
        <div role="dialog" aria-label="Share card preview" onClick={() => setUrl(null)}
          style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,.7)", display: "grid", placeItems: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="share card" style={{ width: "min(80vw,900px)", borderRadius: 16, border: "1px solid rgba(201,206,214,.6)" }} />
        </div>
      )}
    </>
  );
}
