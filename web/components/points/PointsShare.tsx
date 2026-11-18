"use client";
/**
 * Points card (maker 2026-11-18, the Variational-style card): lifetime points, rank and this season's tier as one image
 * (/api/og/points), with Post it and Save image. The link is /u/<name>?card=points, which unfurls to the same card on X.
 */
import { useState } from "react";
import { withBase } from "@/lib/base-path";
import Sheet from "@/components/profile/Sheet";

export const pointsPost = (pts: number, rank: number, url: string) =>
  `${pts.toLocaleString("en-US")} points on @disciplevip\nrank #${rank.toLocaleString("en-US")}\n\n${url}`;

export default function PointsShare({ handle, pts, rank, open, onClose }: { handle: string; pts: number; rank: number; open: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  if (!open) return null;
  const img = withBase(`/api/og/points?u=${encodeURIComponent(handle)}`);
  const url = `${window.location.origin}${withBase(`/u/${encodeURIComponent(handle)}?card=points`)}`;
  const post = pointsPost(pts, rank, url);
  const copy = async () => { try { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* blocked */ } };
  return (
    <Sheet open={open} onClose={onClose} label="Points card" className="r2-modal pt-share" testId="points-share">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="pt-card" src={img} alt={`${pts.toLocaleString("en-US")} points, rank ${rank}`} decoding="async" />
      <div className="pt-acts">
        <button type="button" className="r2-gold pt-x" onClick={() => window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(post)}`, "_blank", "noopener,noreferrer")} data-testid="points-x">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M17.5 3h3.2l-7 8 8.3 10h-6.5l-5-6.2L4.8 21H1.6l7.5-8.6L1.2 3h6.6l4.6 5.7L17.5 3z" /></svg>
          Post it
        </button>
        <a className="pt-btn" href={img} download={`disciple-points-${handle}.jpg`} data-testid="points-save">Save image</a>
        <button type="button" className="pt-btn" onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</button>
      </div>
    </Sheet>
  );
}
