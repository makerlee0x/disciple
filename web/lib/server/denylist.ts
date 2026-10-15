import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { MODERATION } from "@/lib/config";
import { hamming } from "./image";

/**
 * Denylist store. Stub: JSON file at $DENYLIST_PATH (default web/.data/denylist.json).
 * Swap for KV/Redis/Postgres in production via the same two functions.
 */
type Entry = { sha256: string; phash: string; reason: string; at: string };
const FILE = process.env.DENYLIST_PATH || path.join(process.cwd(), ".data", "denylist.json");

async function readAll(): Promise<Entry[]> {
  try { return JSON.parse(await fs.readFile(FILE, "utf8")); } catch { return []; }
}

export async function isDenied(sha: string, phash: string): Promise<Entry | null> {
  const all = await readAll();
  return all.find((e) => e.sha256 === sha || hamming(e.phash, phash) <= MODERATION.phashMaxDistance) || null;
}

export async function deny(sha: string, phash: string, reason: string) {
  const all = await readAll();
  if (all.some((e) => e.sha256 === sha)) return;
  all.push({ sha256: sha, phash, reason, at: new Date().toISOString() });
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(all, null, 2));
}
