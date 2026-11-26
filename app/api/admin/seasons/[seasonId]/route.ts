import { NextResponse } from "next/server";
import { authorizeAdmin, errorResponse } from "@/lib/admin-api";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ seasonId: string }> },
) {
  try {
    const { context, response } = await authorizeAdmin();
    if (!context) return response;

    const { seasonId } = await params;
    if (!uuidPattern.test(seasonId)) {
      return errorResponse(new Error("The season ID is invalid."), 400);
    }

    const { data, error } = await context.supabase
      .from("seasons")
      .delete()
      .eq("id", seasonId)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`Could not delete season: ${error.message}`);
    if (!data) {
      return NextResponse.json({ error: "Season not found." }, { status: 404 });
    }

    return NextResponse.json({ deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}
