// Reserved usernames (lib/server/reservedNames) + bindReserved (lib/server/usernames).  pnpm test:reserved-names
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.KV_ALLOW_LOCAL = "1";
process.env.KV_LOCAL_FILE = join(mkdtempSync(join(tmpdir(), "rn-")), "kv.json");
const { reservedOwners, ownsReserved, reservedNameFor, isReserved } = await import("../lib/server/reservedNames");
const { bindReserved, claim, usernameOf, walletOf } = await import("../lib/server/usernames");

test("unset config reserves maker for ADMIN_EMAILS", () => {
  const env = { ADMIN_EMAILS: "Boss@Example.com, x@y.io" } as NodeJS.ProcessEnv;
  assert.deepEqual([...reservedOwners(env).get("maker")!], ["boss@example.com", "x@y.io"]);
  assert.equal(ownsReserved("maker", ["boss@example.com"], env), true);
  assert.equal(ownsReserved("maker", ["rando@z.io"], env), false);
  assert.equal(reservedOwners({} as NodeJS.ProcessEnv).size, 0, "no admins, nothing reserved");
});

test("RESERVED_USERNAMES wins and parses several names / emails", () => {
  const env = { RESERVED_USERNAMES: "@Maker:a@b.co|c@d.co, bad name:e@f.co, nope:not-an-email, lee:l@e.co", ADMIN_EMAILS: "boss@example.com" } as NodeJS.ProcessEnv;
  const m = reservedOwners(env);
  assert.deepEqual([...m.keys()], ["maker", "lee"]);
  assert.equal(ownsReserved("maker", ["C@D.co"], env), true);
  assert.equal(ownsReserved("maker", ["boss@example.com"], env), false);
  assert.equal(reservedNameFor(["l@e.co"], env), "lee");
  assert.equal(reservedNameFor(["zz@e.co"], env), null);
  assert.equal(isReserved("MAKER", env), true);
});

test("bindReserved moves the name off a squatter and onto the owner's new wallet", async () => {
  const squat = "0x" + "1".repeat(40), w1 = "0x" + "a".repeat(40), w2 = "0x" + "b".repeat(40);
  assert.deepEqual(await claim("maker", squat), { ok: true });
  assert.deepEqual(await claim("oldname", w1), { ok: true });
  const r = await bindReserved("maker", w1);
  assert.equal(r.moved, true); assert.equal(r.from, squat);
  assert.equal(await walletOf("maker"), w1);
  assert.equal(await usernameOf(w1), "maker");
  assert.equal(await usernameOf(squat), null, "squatter loses it");
  assert.equal(await walletOf("oldname"), null, "owner's previous name is released");
  assert.equal((await bindReserved("maker", w1)).moved, false, "idempotent");
  // owner signs in with another login (new wallet): the name follows
  await bindReserved("maker", w2.toUpperCase().replace("0X", "0x"));
  assert.equal(await walletOf("maker"), w2);
  assert.equal(await usernameOf(w1), null);
});
