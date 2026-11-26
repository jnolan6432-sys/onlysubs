import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { authorizeAdmin, errorResponse, requestOrigin } from "@/lib/admin-api";
import { createServiceClient } from "@/lib/admin";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ seasonId: string }> },
) {
  try {
    const { context, response } = await authorizeAdmin();
    if (!context) return response;

    const { seasonId } = await params;
    const { data: members, error: membersError } = await context.supabase
      .from("season_pool_members")
      .select("user_id")
      .eq("season_id", seasonId);
    if (membersError) throw new Error(`Could not load season invitees: ${membersError.message}`);
    if (!members?.length) {
      return NextResponse.json(
        { sent: 0, failed: [], message: "There are no players in this season pool." },
      );
    }

    const userIds = members.map((member) => member.user_id);
    const serviceClient = createServiceClient();
    const users = await Promise.all(
      userIds.map(async (userId) => {
        const { data, error } = await serviceClient.auth.admin.getUserById(userId);
        if (error) {
          throw new Error(`Could not check player sign-in status: ${error.message}`);
        }
        return data.user;
      }),
    );
    const inviteUserIds = users
      .filter((user) => user && !user.last_sign_in_at)
      .map((user) => user.id);
    if (!inviteUserIds.length) {
      return NextResponse.json({
        sent: 0,
        failed: [],
        message: "All players in this season have already logged in.",
      });
    }

    const { data: profiles, error: profilesError } = await context.supabase
      .from("profiles")
      .select("email")
      .in("id", inviteUserIds);
    if (profilesError) throw new Error(`Could not load player emails: ${profilesError.message}`);

    const emails = [...new Set(
      (profiles ?? [])
        .map((profile) => profile.email?.trim().toLowerCase())
        .filter((email): email is string => Boolean(email)),
    )];
    if (!emails.length) {
      return NextResponse.json(
        { sent: 0, failed: [], message: "No email addresses are available to invite." },
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      throw new Error("Supabase URL and anon key must be configured.");
    }

    const authClient = createSupabaseClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const failed: { email: string; error: string }[] = [];
    let sent = 0;
    const emailRedirectTo = new URL("/auth/callback", requestOrigin(request)).toString();

    for (const email of emails) {
      const { error } = await authClient.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
          emailRedirectTo,
        },
      });
      if (error) failed.push({ email, error: error.message });
      else sent += 1;
    }

    return NextResponse.json(
      {
        sent,
        failed,
        message:
          failed.length === 0
            ? `Magic links sent to ${sent} players.`
            : `Sent ${sent} magic link${sent === 1 ? "" : "s"}; ${failed.length} failed.`,
      },
      { status: failed.length === emails.length ? 502 : 200 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
