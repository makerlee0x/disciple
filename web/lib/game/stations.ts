/**
 * In-game radio stations. Add a later station by appending to STATIONS
 * (id, label, track srcs) — the player and the mini-player picker already look up by id and
 * loop that list, so no rewrite.
 */
export type RadioTrack = { src: string; title: string };
export type RadioStation = { id: string; label: string; tracks: readonly RadioTrack[] };

export const HOUSE_STATION: RadioStation = {
  id: "house",
  label: "House",
  tracks: [
    { src: "/audio/radio/house/candlelit-nocturne.m4a", title: "Candlelit Nocturne" },
    { src: "/audio/radio/house/cavernous-reverb.m4a", title: "Cavernous Reverb" },
    { src: "/audio/radio/house/golden-hour-basement.m4a", title: "Golden Hour Basement" },
    { src: "/audio/radio/house/open-sky.m4a", title: "Open Sky" },
    { src: "/audio/radio/house/stadium-chaos.m4a", title: "Stadium Chaos" },
    { src: "/audio/radio/house/sun-bleached-groove.m4a", title: "Sun-Bleached Groove" },
    { src: "/audio/radio/house/voice-memo-loop.m4a", title: "Voice Memo Loop" },
  ],
};

export const CINEMATIC_STATION: RadioStation = {
  id: "cinematic",
  label: "Cinematic",
  tracks: [
    { src: "/audio/radio/cinematic/viento-desierto.m4a", title: "Viento Desierto" },
    { src: "/audio/radio/cinematic/vasta-negativa.m4a", title: "Vasta Negativa" },
    { src: "/audio/radio/cinematic/empty-night-city.m4a", title: "Empty Night City" },
    { src: "/audio/radio/cinematic/mist-of-the-elvendeep.m4a", title: "Mist of the Elvendeep" },
    { src: "/audio/radio/cinematic/northern-silence.m4a", title: "Northern Silence" },
  ],
};

export const STATIONS: Record<string, RadioStation> = { house: HOUSE_STATION, cinematic: CINEMATIC_STATION };
export const DEFAULT_STATION_ID = "house";

export function stationOf(id: string = DEFAULT_STATION_ID): RadioStation {
  return STATIONS[id] ?? HOUSE_STATION;
}

export function stationList(): RadioStation[] {
  return Object.values(STATIONS);
}

export function identityOrder(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/** Fisher–Yates. If `keepFirst` is set, that track is moved to the front after the shuffle. */
export function shuffledOrder(n: number, rng: () => number = Math.random, keepFirst?: number): number[] {
  const a = identityOrder(n);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]!; a[i] = a[j]!; a[j] = t;
  }
  if (keepFirst != null && n > 0) {
    const i = a.indexOf(keepFirst);
    if (i > 0) { a.splice(i, 1); a.unshift(keepFirst); }
  }
  return a;
}

export function nextTrackIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return (index + 1) % length;
}

export function stepTrack(order: number[], currentTrack: number, dir: 1 | -1): number {
  if (!order.length) return 0;
  const i = order.indexOf(currentTrack);
  const pos = i < 0 ? 0 : i;
  return order[(pos + dir + order.length) % order.length]!;
}

/** Play only after a user gesture has unlocked audio, and only when the music channel has level. */
export function radioShouldPlay(level: number, unlocked: boolean): boolean {
  return unlocked && level > 0;
}

export type RepeatMode = "station" | "one";
