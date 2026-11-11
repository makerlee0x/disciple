// game/hide-season-ui — Season copy stays in source, but is hidden in the rendered docs while REAL_PROGRESS is off.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hideSeasonInDocs, docsStillShowSeason } from "../lib/docs/hideSeason.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (c, msg) => { if (c) console.log("ok  ", msg); else { failed++; console.log("FAIL", msg); } };

const content = readFileSync(join(web, "lib/docs/content.ts"), "utf8");
ok(content.includes("hideSeasonInDocs"), "docs renderer calls hideSeasonInDocs");
ok(content.includes("REAL_PROGRESS_ENABLED"), "docs hide uses the existing REAL_PROGRESS_ENABLED flag");
ok(!/REAL_PROGRESS_ENABLED \? hideSeason/.test(content), "season docs are hidden when the flag is off, not on");

const root = join(web, "content/docs/v1");
const files = [];
for (const dir of readdirSync(root)) {
  const d = join(root, dir);
  try { for (const f of readdirSync(d).filter((x) => x.endsWith(".md"))) files.push(join(dir, f)); } catch { /* file */ }
}
ok(files.length > 0, `found ${files.length} docs pages`);

const seasonFiles = [];
for (const rel of files) {
  const raw = readFileSync(join(root, rel), "utf8");
  if (docsStillShowSeason(raw)) seasonFiles.push(rel);
  const hidden = hideSeasonInDocs(raw);
  if (docsStillShowSeason(hidden)) {
    failed++;
    console.log("FAIL leftover Season UI in", rel);
    const lines = hidden.split("\n").filter((l) => /season/i.test(l) && !/\[CONFIRM:/.test(l));
    for (const l of lines) console.log("     ", l);
  }
}
ok(seasonFiles.length >= 3, `source still has Season copy in ${seasonFiles.length} files (not deleted): ${seasonFiles.join(", ")}`);
ok(!docsStillShowSeason(hideSeasonInDocs(readFileSync(join(root, "06-game/04-achievements-and-points.md"), "utf8"))), "Achievements and points: Season ranks / Seasonal / season goals hidden");
ok(!docsStillShowSeason(hideSeasonInDocs(readFileSync(join(root, "08-reference/03-glossary.md"), "utf8"))), "Glossary: Season rank row hidden");
ok(!docsStillShowSeason(hideSeasonInDocs(readFileSync(join(root, "06-game/03-crew.md"), "utf8"))), "Crew: 'season rank' hidden, rest of the pilot sentence kept");

const crew = hideSeasonInDocs(readFileSync(join(root, "06-game/03-crew.md"), "utf8"));
ok(/Your profile shows your pilot stats, achievements, identity\./.test(crew), "crew sentence still reads naturally after the hide");
const ach = hideSeasonInDocs(readFileSync(join(root, "06-game/04-achievements-and-points.md"), "utf8"));
ok(/achievements and filled tramps and walls/.test(ach), "rHALO sentence still reads naturally");
ok(/^## Level and prestige/m.test(ach), "Level and prestige section is kept");
ok(!/^## Season ranks/m.test(ach), "Season ranks heading is gone from the hidden render");

const profile = readFileSync(join(web, "components/profile/ProfileDashboard.tsx"), "utf8");
ok(/REAL_PROGRESS_ENABLED/.test(profile) && /season tier/.test(profile), "profile season tier already gated on REAL_PROGRESS_ENABLED");

if (failed) { console.error(failed + " hide-season-ui check(s) FAILED"); process.exit(1); }
console.log("hide-season-ui checks passed");
