/** loads public/turbo/duel/engine.js (window.DuelEngine) once; the Trading Duel and Climb both mount it */
export const ENGINE_SRC = "/turbo/duel/engine.js?v=84";

export function loadDuelEngine(): Promise<void> {
  const w = window as unknown as { DuelEngine?: unknown };
  if (w.DuelEngine) return Promise.resolve();
  return new Promise((res, rej) => {
    const el = document.createElement("script"); el.src = ENGINE_SRC; el.async = true;
    el.onload = () => res(); el.onerror = () => rej(new Error("engine")); document.head.appendChild(el);
  });
}

export const DUEL_SKIES = ["sky0", "sky1", "sky2", "sky3", "sky4"];
/** extra plates for the random sky each duel (engine SKY_THEMES) */
export const EXTRA_SKIES = { skyEth: "/turbo/sky-eth.webp", skyBtc: "/turbo/sky-btc.webp", skyPad: "/home/pad/sky-1280.webp" };
