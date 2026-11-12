/**
 * In-game radio stations. V1 ships House only. Add a later station by appending to STATIONS
 * (id, track srcs) — the player already looks up by id and loops that list, so no rewrite.
 */
export type RadioTrack = { src: string };
export type RadioStation = { id: string; tracks: readonly RadioTrack[] };

export const HOUSE_STATION: RadioStation = {
  id: "house",
  tracks: [
    { src: "/audio/radio/house/candlelit-nocturne.m4a" },
    { src: "/audio/radio/house/cavernous-reverb.m4a" },
    { src: "/audio/radio/house/golden-hour-basement.m4a" },
    { src: "/audio/radio/house/open-sky.m4a" },
    { src: "/audio/radio/house/stadium-chaos.m4a" },
    { src: "/audio/radio/house/sun-bleached-groove.m4a" },
    { src: "/audio/radio/house/voice-memo-loop.m4a" },
  ],
};

export const STATIONS: Record<string, RadioStation> = { house: HOUSE_STATION };
export const DEFAULT_STATION_ID = "house";

export function stationOf(id: string = DEFAULT_STATION_ID): RadioStation {
  return STATIONS[id] ?? HOUSE_STATION;
}

export function nextTrackIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return (index + 1) % length;
}

/** Play only after a user gesture has unlocked audio, and only when the music channel has level. */
export function radioShouldPlay(level: number, unlocked: boolean): boolean {
  return unlocked && level > 0;
}
