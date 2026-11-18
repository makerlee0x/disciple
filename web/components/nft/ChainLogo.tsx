/** Real Solana / Ethereum marks for holder wallet rows and tiles (maker 2026-11-18: no placeholder glyphs). */
import { useId } from "react";
import type { HolderChain } from "@/lib/nft/config";

export default function ChainLogo({ chain, size = 26 }: { chain: HolderChain; size?: number }) {
  const id = useId().replace(/:/g, "");
  if (chain === "sol") return (
    <svg className="nft-chain sol" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id={`sg${id}`} x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#9945FF" /><stop offset="1" stopColor="#14F195" /></linearGradient>
      </defs>
      <circle cx="16" cy="16" r="16" fill="#000" />
      <g transform="translate(7.5 9.3) scale(0.0428)" fill={`url(#sg${id})`}>
        <path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" />
        <path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" />
        <path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z" />
      </g>
    </svg>
  );
  return (
    <svg className="nft-chain eth" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <g transform="translate(9.65 5.65) scale(0.0496)" fill="#fff">
        <path fillOpacity=".6" d="M127.961 0l-2.795 9.5v275.668l2.795 2.79 127.962-75.638z" />
        <path d="M127.962 0L0 212.32l127.962 75.639V154.158z" />
        <path fillOpacity=".6" d="M127.961 312.187l-1.575 1.92v98.199l1.575 4.6L256 236.587z" />
        <path d="M127.962 416.905v-104.72L0 236.585z" />
        <path fillOpacity=".2" d="M127.961 287.958l127.96-75.637-127.96-58.162z" />
        <path fillOpacity=".6" d="M0 212.32l127.96 75.638v-133.8z" />
      </g>
    </svg>
  );
}
