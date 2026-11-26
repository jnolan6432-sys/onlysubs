"use client";

import { FormEvent, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function AuthForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  async function sendLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setMessage("");
    setError("");

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (authError) {
      setError(authError.message);
    } else {
      setMessage("Check your inbox for your sign-in link.");
    }
    setSending(false);
  }

  return (
    <form className="mt-7 space-y-4" onSubmit={sendLink}>
      <label className="block text-sm font-medium" htmlFor="email">
        Email address
      </label>
      <input
        autoComplete="email"
        className="w-full rounded-lg border border-slate-300 px-4 py-3 outline-none transition focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
        id="email"
        name="email"
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@example.com"
        required
        type="email"
        value={email}
      />
      <button
        className="w-full rounded-lg bg-teal-800 px-4 py-3 font-semibold text-white transition hover:bg-teal-900 disabled:cursor-wait disabled:opacity-60"
        disabled={sending}
        type="submit"
      >
        {sending ? "Sending link..." : "Email me a sign-in link"}
      </button>
      {message && (
        <p aria-live="polite" className="text-sm text-teal-800">
          {message}
        </p>
      )}
      {error && (
        <p aria-live="polite" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}
