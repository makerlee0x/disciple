import AdminVerify from "@/components/claims/AdminVerify";
import { parseAdminEmails } from "@/lib/server/privyAuth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Verification review · DISCIPLE", robots: { index: false, follow: false } };
/** Fail closed: with ADMIN_EMAILS unset/blank the page never asks for a login and the API answers 503. */
export default function Page() {
  return <AdminVerify configured={!!parseAdminEmails(process.env.ADMIN_EMAILS)} />;
}
