import AdminMint from "@/components/nft/AdminMint";
import { parseAdminEmails } from "@/lib/server/privyAuth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mint setup · DISCIPLE", robots: { index: false, follow: false } };
/** Fail closed: with ADMIN_EMAILS unset the API answers 503 and the page only says so. */
export default function Page() {
  return <AdminMint configured={!!parseAdminEmails(process.env.ADMIN_EMAILS)} />;
}
