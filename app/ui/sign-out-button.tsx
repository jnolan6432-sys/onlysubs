"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton({ compact = false }: { compact?: boolean }) {
  const [error, setError] = useState("");
  const router = useRouter();

  async function signOut() {
    const { error: signOutError } = await createClient().auth.signOut();
    if (signOutError) {
      setError(signOutError.message);
      return;
    }
    router.refresh();
  }

  return (
    <div>
      <button
        className={compact ? "block w-full px-2 py-2 text-left hover:bg-slate-50" : "rounded-lg border border-slate-300 px-4 py-3 font-medium text-slate-700 hover:bg-slate-50"}
        onClick={signOut}
        type="button"
      >
        Sign out
      </button>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
