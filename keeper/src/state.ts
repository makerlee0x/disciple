// Small JSON state file: scan cursors, known pools and their sources, and packets not yet delivered.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Hex } from "viem";
import type { PoolSource } from "./hook.ts";

export interface Packet {
  route: string;
  nonce: bigint;
  guid: Hex;
  header: Hex; // PacketV1 header (81 bytes)
  message: Hex;
  receiver: Hex;
  sender: Hex; // bytes32
  srcEid: number;
  sentAt: number; // unix seconds (home block time)
  homeTx: Hex;
  ours: boolean;
  pools: { id: Hex; price: string }[]; // what we expect the pool to take (ours only)
  committed?: boolean;
  /** ours: what this keeper has spent on the packet so far, wei (home tx incl. LayerZero fee, then commit) */
  spent?: string;
  tries: number;
}

export interface RouteState {
  poolCursor?: bigint; // next destination block to scan for Created
  pushCursor?: bigint; // next home block to scan for Pushed
  pools: Record<string, PoolSource>; // id -> source (sources are immutable)
}

export interface State {
  routes: Record<string, RouteState>;
  packets: Packet[];
}

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);
const reviver = (_k: string, v: unknown) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

export function loadState(path: string): State {
  if (!existsSync(path)) return { routes: {}, packets: [] };
  const s = JSON.parse(readFileSync(path, "utf8"), reviver) as State;
  s.routes ??= {};
  s.packets ??= [];
  return s;
}

export function saveState(path: string, s: State): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, replacer, 2));
  renameSync(tmp, path);
}

export function routeState(s: State, name: string): RouteState {
  return (s.routes[name] ??= { pools: {} });
}
