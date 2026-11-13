/**
 * PostCSS: hover styles only on devices that can hover (mobile plan 2026-11-13, touch rule 3).
 * On phones a tapped element keeps :hover until the next tap elsewhere ("sticky hover"), so a button looks lit after you
 * let go. This wraps every selector that uses :hover in @media (hover: hover). Selectors without :hover stay where they are.
 * Rules already inside a hover/pointer media query are left alone.
 */
const QUERY = "(hover: hover)";
const insideHoverMedia = (node) => {
  for (let p = node.parent; p; p = p.parent) if (p.type === "atrule" && p.name === "media" && /hover|pointer/.test(p.params)) return true;
  return false;
};
/** split a selector list on top-level commas (not inside :is(), :not(), [attr="a,b"]) */
function splitSelectors(sel) {
  const out = []; let depth = 0, quote = "", cur = "";
  for (const ch of sel) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
module.exports = () => ({
  postcssPlugin: "disciple-hover-media",
  Once(root, { AtRule }) {
    root.walkRules((rule) => {
      if (!rule.selector || !rule.selector.includes(":hover") || insideHoverMedia(rule)) return;
      if (rule.parent && rule.parent.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
      const sels = splitSelectors(rule.selector);
      const hov = sels.filter((s) => s.includes(":hover")), rest = sels.filter((s) => !s.includes(":hover"));
      const media = new AtRule({ name: "media", params: QUERY });
      const clone = rule.clone({ selector: hov.join(",\n") });
      media.append(clone);
      rule.after(media);
      if (rest.length) rule.selector = rest.join(",\n"); else rule.remove();
    });
  },
});
module.exports.postcss = true;
