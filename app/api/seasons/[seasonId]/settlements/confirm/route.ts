import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ seasonId: string }> },
) {
  const { seasonId } = await params;
  if (!uuidPattern.test(seasonId)) {
    return NextResponse.json({ error: "Invalid season." }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json(
      { error: "Sign in to confirm your payments." },
      { status: 401 },
    );
  }

  const { data, error } = await supabase.rpc(
    "confirm_season_settlement_payments",
    { p_season_id: seasonId },
  );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  return NextResponse.json({ confirmedPayments: data ?? 0 });
}
