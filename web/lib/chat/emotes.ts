import { EMOTE_CODES } from "./types";
import { BASE_PATH } from "@/lib/base-path";
/** code → /chat/emotes/<code>.svg. Messages carry emotes as :code: tokens; the UI swaps them for these images. */
export const EMOTES: Record<string, string> = Object.fromEntries(EMOTE_CODES.map((c) => [c, `${BASE_PATH}/chat/emotes/${c}.svg`]));
