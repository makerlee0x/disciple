/**
 * Hide player-visible Season UI in docs markdown while REAL_PROGRESS_ENABLED is off.
 * Source files stay intact (lee: hide behind the existing flag, do not delete).
 */
export function hideSeasonInDocs(src: string): string {
  let out = src;
  // Whole sections whose heading mentions Season (e.g. "## Season ranks")
  out = out.replace(/^#{2,3}[ \t][^\n]*\bSeason\b[^\n]*\n(?:(?!^#{2,3}[ \t]).*\n?)*/gim, "");
  // Table rows (glossary, category table) that mention Season / Seasonal
  out = out.replace(/^\|.*\bSeason(?:al)?\b.*\|\s*\n/gim, "");
  // Known leftover phrases in otherwise-kept paragraphs
  out = out.replace(/\bachievements, season goals and filled\b/gi, "achievements and filled");
  out = out.replace(/\bidentity and season rank\b/gi, "identity");
  return out;
}

/** True when rendered (or pre-render markdown) still has player-visible Season UI. */
export function docsStillShowSeason(text: string): boolean {
  const stripped = text
    .replace(/[ \t]*\[CONFIRM:[^\]]*\]/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return /\bSeason(?:al)?\b|\bseason (?:rank|ranks|goals?|pass|tier|points)\b|\bSeason 1\b/i.test(stripped);
}
