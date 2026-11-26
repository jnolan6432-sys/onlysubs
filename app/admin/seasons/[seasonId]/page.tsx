import { redirect } from "next/navigation";

export default async function SeasonPage({ params }: { params: Promise<{ seasonId: string }> }) {
  const { seasonId } = await params;
  redirect(`/admin?season=${encodeURIComponent(seasonId)}`);
}
