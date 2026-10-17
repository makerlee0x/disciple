"use client";
/**
 * /how-it-works below-the-fold charts, code-split: each chart is a next/dynamic import (ssr: false) that LazyMount only
 * renders once its slot is within 400px of the viewport, so neither the SVG nor its JS is in the first load. The slots keep
 * a fixed min-height (LazyMount) so nothing moves when a chart arrives.
 */
import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import LazyMount from "./LazyMount";

const load = () => import("./charts");
const Curve = dynamic(() => load().then((m) => m.CurveChart), { ssr: false });
const Snipe = dynamic(() => load().then((m) => m.SnipeChart), { ssr: false });
const SparkC = dynamic(() => load().then((m) => m.Spark), { ssr: false });

type Slot = { minHeight: number | string; className?: string };

export function LazyCurveChart({ minHeight, className, ...p }: Slot & ComponentProps<typeof Curve>) {
  return <LazyMount minHeight={minHeight} className={className}><Curve {...p} /></LazyMount>;
}
export function LazySnipeChart({ minHeight, className }: Slot) {
  return <LazyMount minHeight={minHeight} className={className}><Snipe /></LazyMount>;
}
export function LazySpark({ minHeight, className, ...p }: Slot & ComponentProps<typeof SparkC>) {
  return <LazyMount minHeight={minHeight} className={className}><SparkC {...p} /></LazyMount>;
}
