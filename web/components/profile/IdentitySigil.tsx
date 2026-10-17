import type { IdentityId } from "@/lib/identity";
import { IDENTITIES } from "@/lib/identity";

/** Color + glyph per CT identity (angel/heaven palette). */
export const SIGIL: Record<IdentityId, { color: string; glyph: string }> = {
  believer: { color: "#C9CED6", glyph: "halo" },
  trencher: { color: "#9ff3c8", glyph: "bolt" },
  sniper: { color: "#7dffa0", glyph: "target" },
  diamond_hands: { color: "#9fd0ff", glyph: "gem" },
  paper_hands: { color: "#c8cde0", glyph: "feather" },
  exit_liquidity: { color: "#ff8fab", glyph: "down" },
  whale: { color: "#7ec8ff", glyph: "wave" },
  degen: { color: "#ff7eb9", glyph: "dice" },
  bag_holder: { color: "#b8a0d8", glyph: "bag" },
  jeet: { color: "#ffb37e", glyph: "down" },
  bomber: { color: "#ff6b6b", glyph: "flame" },
  nuker: { color: "#ff4d6d", glyph: "flame" },
  crew_captain: { color: "#FF7A3D", glyph: "crown" },
  gate_keeper: { color: "#E8EAEE", glyph: "gate" },
  dev_supporter: { color: "#c9b6f2", glyph: "star" },
  launcher: { color: "#FF7A3D", glyph: "rocket" },
  kingmaker: { color: "#FF7A3D", glyph: "crown" },
  farmer: { color: "#b5e48c", glyph: "wheat" },
  smart_money: { color: "#E8EAEE", glyph: "wings" },
};

export function identityLabel(id: IdentityId): string {
  return IDENTITIES.find((d) => d.id === id)?.label ?? "Pilgrim";
}

function Glyph({ g, c }: { g: string; c: string }) {
  const p = { fill: "none", stroke: c, strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (g) {
    case "halo":
      return <><ellipse cx="12" cy="7" rx="6" ry="2" {...p} /><circle cx="12" cy="15" r="4" {...p} /></>;
    case "bolt":
      return <path d="M13 3L6 13h5l-1 8 7-10h-5z" {...p} />;
    case "target":
      return <><circle cx="12" cy="12" r="7" {...p} /><circle cx="12" cy="12" r="2.5" {...p} /></>;
    case "gem":
      return <path d="M6 9l3-4h6l3 4-6 10z M6 9h12" {...p} />;
    case "feather":
      return <path d="M18 5c-6 0-11 5-11 12l-2 2M9 15h5" {...p} />;
    case "down":
      return <path d="M12 4v14M6 12l6 6 6-6" {...p} />;
    case "wave":
      return <path d="M3 14c3-3 6 3 9 0s6 3 9 0M3 9c3-3 6 3 9 0s6 3 9 0" {...p} />;
    case "dice":
      return <><rect x="5" y="5" width="14" height="14" rx="3" {...p} /><circle cx="9" cy="9" r="1" fill={c} /><circle cx="15" cy="15" r="1" fill={c} /><circle cx="12" cy="12" r="1" fill={c} /></>;
    case "bag":
      return <path d="M8 8h8l2 11H6zM9 8a3 3 0 016 0" {...p} />;
    case "flame":
      return <path d="M12 3c3 4 6 6 6 10a6 6 0 01-12 0c0-3 2-4 3-7 1 2 2 3 3 3 0-2 0-4 0-6z" {...p} />;
    case "crown":
      return <path d="M4 17h16M5 17l-1-9 5 4 3-6 3 6 5-4-1 9" {...p} />;
    case "gate":
      return <path d="M5 20V10a7 7 0 0114 0v10M9 20v-8M15 20v-8" {...p} />;
    case "star":
      return <path d="M12 4l2.3 5 5.4.6-4 3.7 1.1 5.3L12 16l-4.8 2.6 1.1-5.3-4-3.7 5.4-.6z" {...p} />;
    case "rocket":
      return <path d="M12 3c3 2 4 6 4 9l-2 4h-4l-2-4c0-3 1-7 4-9zM10 19l2 2 2-2" {...p} />;
    case "wheat":
      return <path d="M12 21V8M12 8c-2-2-2-4 0-5 2 1 2 3 0 5M12 13c-3 0-4-2-4-4M12 13c3 0 4-2 4-4" {...p} />;
    case "wings":
    default:
      return <><path d="M12 12C9 8 5 7 3 9c2 1 3 3 3 5 2 0 4-1 6-2zM12 12c3-4 7-5 9-3-2 1-3 3-3 5-2 0-4-1-6-2z" {...p} /><ellipse cx="12" cy="5" rx="3.5" ry="1.1" {...p} /></>;
  }
}

/** Round avatar sigil for a CT identity. */
export default function IdentitySigil({ id, size = 36 }: { id: IdentityId; size?: number }) {
  const s = SIGIL[id] ?? SIGIL.believer;
  return (
    <span
      className="id-sigil"
      title={identityLabel(id)}
      style={{
        width: size,
        height: size,
        borderColor: s.color,
        boxShadow: `0 0 12px ${s.color}55, inset 0 0 10px ${s.color}22`,
      }}
    >
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} aria-hidden="true">
        <Glyph g={s.glyph} c={s.color} />
      </svg>
    </span>
  );
}
