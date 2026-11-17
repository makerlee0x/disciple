/**
 * Reserved usernames: a name that belongs to a PERSON (their sign-in email), not to whichever wallet claimed it first.
 *
 * Why (maker, 2026-11-17: "just give @maker to my account, it keeps forgetting or changing it"): usernames are bound to
 * a wallet (lib/server/usernames), and Privy gives each login a wallet. Signing in with email, Google or Apple can land
 * on a different Privy user, so a different wallet, which has no name (or another one). A reserved name instead
 * follows its owner: whenever the owner signs in, the name is moved onto the wallet they are using
 * (/api/profile/username/reserved), and nobody else can claim it.
 *
 * Config (server only, never in code): RESERVED_USERNAMES="maker:me@example.com|other@example.com,name2:x@y.z".
 * Unset ⇒ "maker" is reserved for ADMIN_EMAILS (already set in production), so it works with no new setting.
 * An owner is a verified Privy email (email, Google or Apple login; lib/server/privyAuth userFromLinkedAccounts).
 * Pure (env injectable): unit-tested by scripts/test-reserved-names.mts.
 */
import { parseAdminEmails } from "./privyAuth";

const NAME_RE = /^[a-z0-9_]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Names reserved for ADMIN_EMAILS when RESERVED_USERNAMES is unset. */
export const DEFAULT_RESERVED = ["maker"] as const;

/** name → owner emails (lowercased). Bad entries are skipped; a name with no valid email is not reserved. */
export function reservedOwners(env: NodeJS.ProcessEnv = process.env): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const raw = (env.RESERVED_USERNAMES ?? "").trim();
  if (!raw) {
    const admins = parseAdminEmails(env.ADMIN_EMAILS);
    if (admins) for (const n of DEFAULT_RESERVED) out.set(n, new Set(admins));
    return out;
  }
  for (const part of raw.split(",")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const name = part.slice(0, i).trim().toLowerCase().replace(/^@/, "");
    const emails = part.slice(i + 1).split("|").map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_RE.test(e));
    if (!NAME_RE.test(name) || !emails.length) continue;
    const s = out.get(name) ?? new Set<string>();
    emails.forEach((e) => s.add(e));
    out.set(name, s);
  }
  return out;
}

/** Is `name` reserved for someone? */
export const isReserved = (name: string, env?: NodeJS.ProcessEnv) => reservedOwners(env).has(name.toLowerCase());

/** May a player with these verified emails hold `name`? (Not reserved ⇒ false: use the normal claim.) */
export function ownsReserved(name: string, emails: string[], env?: NodeJS.ProcessEnv): boolean {
  const owners = reservedOwners(env).get(name.toLowerCase());
  return !!owners && emails.some((e) => owners.has(e.toLowerCase()));
}

/** The reserved name these emails own (first match in config order), or null. */
export function reservedNameFor(emails: string[], env?: NodeJS.ProcessEnv): string | null {
  const mine = new Set(emails.map((e) => e.toLowerCase()));
  for (const [name, owners] of reservedOwners(env)) if ([...owners].some((e) => mine.has(e))) return name;
  return null;
}
