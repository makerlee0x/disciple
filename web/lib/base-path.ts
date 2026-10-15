/** Prefix root-absolute paths when STATIC_PREVIEW sets NEXT_PUBLIC_BASE_PATH (raw.githack). */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
export const IS_STATIC_PREVIEW = process.env.NEXT_PUBLIC_STATIC_PREVIEW === "1";

export function withBase(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  if (!BASE_PATH) return path;
  if (path === BASE_PATH || path.startsWith(BASE_PATH + "/")) return path;
  return `${BASE_PATH}${path}`;
}
