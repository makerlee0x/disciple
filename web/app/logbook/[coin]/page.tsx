import RocketStory from "@/components/logbook/RocketStory";

export const metadata = { title: "Rocket story · DISCIPLE" };

export function generateStaticParams() {
  return process.env.STATIC_PREVIEW === "1" ? [{ coin: "0x0000000000000000000000000000000000000000" }] : [];
}

export default async function Page({ params }: { params: Promise<{ coin: string }> }) {
  const { coin } = await params;
  return <RocketStory coin={coin.toLowerCase()} />;
}
