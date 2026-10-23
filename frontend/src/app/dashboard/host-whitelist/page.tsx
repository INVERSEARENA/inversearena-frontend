"use client";

import { FormEvent, useState } from "react";

export default function HostWhitelistPage() {
  const [contact, setContact] = useState("");
  const [intent, setIntent] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/whitelist-applications", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contact, intent }),
    });
    setMessage(response.ok ? "Application submitted for admin review." : "Unable to submit. Check that your wallet is signed in and try again.");
    setBusy(false);
  }

  return (
    <main className="min-h-screen bg-black px-6 py-24 text-white">
      <div className="mx-auto max-w-xl border-2 border-neon-green p-8">
        <h1 className="text-3xl font-black uppercase text-neon-green">Host whitelist application</h1>
        <p className="mt-3 text-sm text-zinc-400">Your signed-in wallet is attached automatically. Admin approval prepares the on-chain transaction.</p>
        <form onSubmit={submit} className="mt-8 space-y-5">
          <label className="block text-sm uppercase tracking-widest">Contact<input required value={contact} onChange={(e) => setContact(e.target.value)} className="mt-2 w-full border border-zinc-700 bg-zinc-950 p-3" placeholder="email or Discord" /></label>
          <label className="block text-sm uppercase tracking-widest">Intent<textarea required minLength={10} value={intent} onChange={(e) => setIntent(e.target.value)} className="mt-2 min-h-36 w-full border border-zinc-700 bg-zinc-950 p-3" placeholder="Tell us what you plan to host" /></label>
          <button disabled={busy} className="bg-neon-green px-6 py-3 font-black text-black disabled:opacity-50">{busy ? "SUBMITTING..." : "SUBMIT APPLICATION"}</button>
        </form>
        {message && <p className="mt-5 text-sm text-neon-green" role="status">{message}</p>}
      </div>
    </main>
  );
}
