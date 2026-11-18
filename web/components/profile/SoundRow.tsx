"use client";
import { setGameSettings, useGameSettings, type AudioChannel } from "@/lib/game/settings";
import { previewBlip } from "@/lib/game/audio";

/**
 * Settings › Sound row: Music | Sound effects side by side, the speaker is the on/off switch (same music.on / sfx.on the
 * flight radio pill's mute flips), the slider under it. Shared by Settings (SettingsModal) and the Turbo lobby gear
 * (components/turbo/LobbySettings). Needs the .p5-settings modal styles (app/profile-r5.css).
 */
export default function SoundRow({ music, sfx }: { music: string; sfx: string }) {
  const gs = useGameSettings();
  return (
    <div className="p5-srow p5-split">
      {([["music", music], ["sfx", sfx]] as const).map(([ch, label]) => {
        const c: AudioChannel = gs[ch];
        const set = (n: Partial<AudioChannel>) => setGameSettings((g) => ({ ...g, [ch]: { ...g[ch], ...n } }));
        return (
          <div className="p5-cell snd" key={ch}>
            <div className="hd">
              <b>{label}</b>
              <button type="button" role="switch" aria-checked={c.on} aria-label={label} className={`p5-mute${c.on ? " on" : ""}`} data-testid={`settings-${ch}`}
                onClick={() => set({ on: !c.on })}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M11 5L6 9H2v6h4l5 4V5z" fill={c.on ? "currentColor" : "none"} />{c.on ? <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /> : <path d="M23 9l-6 6M17 9l6 6" />}
                </svg>
              </button>
            </div>
            <input type="range" className="p5-vol" min={0} max={100} step={5} value={Math.round(c.vol * 100)} disabled={!c.on}
              aria-label={`${label} volume`} data-testid={`settings-${ch}-vol`}
              onChange={(e) => set({ vol: Number(e.target.value) / 100 })}
              onPointerUp={() => { if (ch === "sfx") previewBlip(c.vol); }} />
          </div>
        );
      })}
    </div>
  );
}
