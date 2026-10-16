import type { Metadata } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";
import ChatBridge from "@/components/chat/ChatBridge";

export const metadata: Metadata = {
  title: "DISCIPLE — Every coin is a rocket",
  description:
    "DISCIPLE launchpad: pair any coin with any ERC-20. Altitude = price. Robinhood Chain.",
  metadataBase: new URL("https://disciple.vip"),
  icons: { icon: "/favicon.png" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <AppShell>{children}</AppShell>
        <ChatBridge />
      </body>
    </html>
  );
}
