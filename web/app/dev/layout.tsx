import { notFound } from "next/navigation";

/** /dev/* tools render fixtures and mock data: `next dev` only, 404 in every production build (lee, Oct 26 2026). */
export default function DevLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV !== "development") notFound();
  return children;
}
