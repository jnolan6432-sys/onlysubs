import { redirect } from "next/navigation";

export default async function EditSeasonPage({ params }: { params: Promise<{ seasonId: string }> }) {
  const { seasonId } = await params;
  redirect(`/admin?season=${encodeURIComponent(seasonId)}`);
}
