/** Trading Duel wire shapes (server ⇄ match screen). */
import type { Book, BookStep, LengthMs, TierId, TradeAction } from "./rules";

export type DuelMode = "ranked" | "friend";
export type RoomStatus = "lobby" | "live" | "done" | "cancelled";

export interface DuelPlayer {
  /** wallet (lowercase) */
  pid: string;
  name: string;
  rating: number;
  record: { w: number; l: number };
  ready: boolean;
}

export interface DuelResult {
  winner: string | null; // pid, null = draw
  profit: Record<string, number>;
  /** rating change per pid (0 for friendly) */
  delta: Record<string, number>;
  rating: Record<string, number>;
  books: Record<string, Book>;
  price: number;
}

export interface DuelRoom {
  id: string;
  mode: DuelMode;
  tier: TierId;
  lenMs: LengthMs;
  code?: string;
  createdAt: number;
  players: DuelPlayer[];
  status: RoomStatus;
  /** trading opens (after the 3-2-1) */
  startAt?: number;
  /** buzzer; moves 30 s later once on overtime */
  endAt?: number;
  ot?: boolean;
  /** last price the server saw while the duel was live (and when): the buzzer settles at the buzzer's price, not a later one */
  mark?: { p: number; at: number };
  books: Record<string, Book>;
  result?: DuelResult;
  rematch?: { by: string[]; roomId?: string };
  /** last event seq handed out */
  seq: number;
}

export type DuelEvent =
  | { seq: number; ts: number; type: "join" | "ready" | "leave"; pid: string }
  | { seq: number; ts: number; type: "start"; startAt: number; endAt: number }
  | { seq: number; ts: number; type: "trade"; pid: string; action: TradeAction; price: number; steps: BookStep[]; book: Book }
  | { seq: number; ts: number; type: "bomb"; pid: string; price: number; steps: BookStep[]; book: Book }
  | { seq: number; ts: number; type: "chat"; pid: string; text: string }
  | { seq: number; ts: number; type: "trick"; pid: string; kind: "spin" | "flip" }
  | { seq: number; ts: number; type: "overtime"; endAt: number }
  | { seq: number; ts: number; type: "end"; result: DuelResult }
  | { seq: number; ts: number; type: "rematch"; pid: string; roomId?: string };

/** Distributive Omit so each event keeps its own fields. */
export type NewDuelEvent = DuelEvent extends infer E ? (E extends DuelEvent ? Omit<E, "seq" | "ts"> : never) : never;

/** Quick lines in the chat sheet (also what a bot says back). */
export const QUICK_LINES = ["gg", "nice trade", "🚀", "rekt", "lol", "wp", "👀", "catch me"] as const;
export const DUEL_CHAT_MAX = 60;
