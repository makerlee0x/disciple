/**
 * r7 creator-fee illustrations, copied from
 * /workspace/disciple-brand/mockups/quick-launch-r7/src/build.py
 * (_art_keep, _art_pool, _art_burn). Hairline currentColor strokes only.
 */
import type { CreatorFeeDestination } from "@/lib/quickLaunch";

const SW = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function FeeCoin({ x, y, r = 7, op = 1 }: { x: number; y: number; r?: number; op?: number }) {
  return (
    <g opacity={op}>
      <circle cx={x} cy={y} r={r} {...SW} />
      <circle cx={x} cy={y} r={r - 2.8} {...SW} strokeWidth={1} opacity={0.6} />
    </g>
  );
}

function PairCoin({ x, y, r = 7, op = 1 }: { x: number; y: number; r?: number; op?: number }) {
  return (
    <g opacity={op}>
      <circle cx={x} cy={y} r={r} {...SW} />
      <circle cx={x} cy={y} r={r - 3.2} fill="currentColor" opacity={0.85} />
    </g>
  );
}

function RocketCoin({ x, y, r = 7, op = 1 }: { x: number; y: number; r?: number; op?: number }) {
  return (
    <g opacity={op}>
      <circle cx={x} cy={y} r={r} {...SW} />
      <path
        d={`M${x} ${y - 4} C${x + 1.8} ${y - 2} ${x + 1.8} ${y + 1} ${x + 1.3} ${y + 2.6} L${x - 1.3} ${y + 2.6} C${x - 1.8} ${y + 1} ${x - 1.8} ${y - 2} ${x} ${y - 4} Z`}
        fill="currentColor"
      />
      <path d={`M${x - 1.4} ${y + 1.2} L${x - 2.8} ${y + 3.6} M${x + 1.4} ${y + 1.2} L${x + 2.8} ${y + 3.6}`} {...SW} strokeWidth={1} />
    </g>
  );
}

function Arrow({ d, head }: { d: string; head: string }) {
  return (
    <>
      <path d={d} {...SW} strokeDasharray="2 3" />
      <path d={head} {...SW} />
    </>
  );
}

function KeepArt() {
  return (
    <svg viewBox="2 14 118 60" aria-hidden="true">
      <FeeCoin x={14} y={42} op={0.3} />
      <FeeCoin x={34} y={42} op={0.6} />
      <FeeCoin x={54} y={42} />
      <Arrow d="M64 42 L80 42" head="M76 38 L80.5 42 L76 46" />
      <circle cx={100} cy={31} r={8} {...SW} />
      <path d="M86 60 C86 49 91.5 44 100 44 C108.5 44 114 49 114 60" {...SW} />
      <path d="M84 66 L116 66" {...SW} opacity={0.35} />
    </svg>
  );
}

function PoolArt() {
  return (
    <svg viewBox="0 0 120 84" aria-hidden="true">
      <FeeCoin x={16} y={12} op={0.35} />
      <FeeCoin x={34} y={20} op={0.7} />
      <Arrow d="M43 25 C51 29 55 33 57 39" head="M53.5 36.5 L57.5 40 L59 35" />
      <path d="M50 42 L54 70 C54.6 74 56.5 76 60.5 76 L91.5 76 C95.5 76 97.4 74 98 70 L102 42" {...SW} />
      <path d="M53 55 C57 52.5 61 52.5 65 55 S73 57.5 77 55 S85 52.5 89 55 S97 57.5 99 55" {...SW} strokeWidth={1.1} />
      <path
        d="M53 55 C57 52.5 61 52.5 65 55 S73 57.5 77 55 S85 52.5 89 55 S97 57.5 99 55 L97 70 C96.6 73 95 74.5 91.5 74.5 L60.5 74.5 C57 74.5 55.4 73 55 70 Z"
        fill="currentColor"
        opacity={0.12}
      />
      <path d="M103.5 62 L103.5 58 C103.5 55 105.5 53 108 53 C110.5 53 112.5 55 112.5 58 L112.5 62" {...SW} />
      <rect x={100} y={62} width={16} height={13} rx={2.5} {...SW} fill="var(--card-bg)" />
      <circle cx={108} cy={68} r={1.5} fill="currentColor" />
    </svg>
  );
}

const BURN_FRAGS: [number, number, number, number, number][] = [
  [111, 27, 3, 0.75, 20],
  [116, 36, 2.2, 0.5, 40],
  [113, 50, 2.6, 0.6, 10],
  [117, 57, 1.8, 0.35, 30],
  [104, 20, 2, 0.45, 60],
];

function BurnArt() {
  return (
    <svg viewBox="-5 3 125 76" aria-hidden="true">
      <PairCoin x={12} y={20} r={8.5} />
      <Arrow d="M24 20 C50 20 68 25 80 33" head="M75 31.5 L81 34 L77.5 28.5" />
      <RocketCoin x={12} y={62} r={8.5} />
      <Arrow d="M24 62 L35 62" head="M31.5 58.5 L35.5 62 L31.5 65.5" />
      <PairCoin x={46} y={62} r={8.5} />
      <Arrow d="M58 59 C67 55 74 50 80 45" head="M74.5 45.5 L81 44.5 L78.5 50.5" />
      <circle cx={96} cy={39} r={13} {...SW} strokeDasharray="1.8 3.4" opacity={0.6} />
      <path d="M87 48 L105 30" {...SW} strokeWidth={1.6} />
      {BURN_FRAGS.map(([x, y, w, o, a]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={w} height={w} rx={0.6} fill="currentColor" opacity={o} transform={`rotate(${a} ${x} ${y})`} />
      ))}
    </svg>
  );
}

const ART = {
  0: KeepArt,
  1: PoolArt,
  2: BurnArt,
} as const;

export default function CreatorFeeArt({ dest }: { dest: CreatorFeeDestination }) {
  const Art = ART[dest];
  return <Art />;
}
