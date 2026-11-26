import { NextResponse, type NextRequest } from "next/server";
import { getAdminContext } from "@/lib/admin";

export async function authorizeAdmin() {
  const context = await getAdminContext();
  if (context?.isAdmin) return { context, response: null };
  return {
    context: null,
    response: NextResponse.json(
      {
        error: context?.user
          ? "Administrator access is required."
          : "Sign in to continue.",
      },
      { status: context?.user ? 403 : 401 },
    ),
  };
}

export function errorResponse(error: unknown, status = 500) {
  const message =
    error instanceof Error ? error.message : "The request could not be completed.";
  return NextResponse.json({ error: message }, { status });
}

export function requestOrigin(request: NextRequest) {
  return process.env.NEXT_PUBLIC_SITE_URL || request.nextUrl.origin;
}
