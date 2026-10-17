import { SPRITE_SYMBOLS } from "./sprite";

/** BRAND icons v1 + v1.1 merged sprite. Rendered once (hidden) in the root layout; use via <Icon name="…" />. */
export default function IconSprite() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"
      style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
      dangerouslySetInnerHTML={{ __html: SPRITE_SYMBOLS }} />
  );
}
