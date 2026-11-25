"use client";

const STATUSES = [
  {
    status: "READY",
    color: "#3CFF1A",
    desc: "Seated and waiting for quorum. Has committed nothing yet.",
  },
  {
    status: "ACTIVE",
    color: "#63b3ed",
    desc: "Still in the current round. Choice stays hidden while the round is open.",
  },
  {
    status: "ELIMINATED",
    color: "#FF0A54",
    desc: "Chose with the majority in a prior round and is out for the rest of the arena.",
  },
] as const;

const ROW =
  "flex items-start gap-3 rounded-lg border border-white/10 p-4";

/**
 * Lobby state gallery (#1645). Mirrors the participant statuses the lobby
 * client (`ArenaLobbyClient`) renders: READY / ACTIVE / ELIMINATED, plus the
 * empty-lobby state.
 */
export default function LobbyStatesGallery() {
  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-lg font-semibold">Empty lobby</h2>
        <div className={ROW}>
          <span className="text-white/60">
            No players have joined yet. Share the invitation code to fill the
            arena — the round opens once quorum is reached.
          </span>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Participant statuses</h2>
        <div className="space-y-3">
          {STATUSES.map((s) => (
            <div key={s.status} className={ROW}>
              <span
                className="rounded-full px-3 py-1 text-xs font-bold"
                style={{ backgroundColor: `${s.color}22`, color: s.color }}
              >
                {s.status}
              </span>
              <span className="text-white/70">{s.desc}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Joining / ready row</h2>
        <div className="space-y-2">
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className="flex items-center justify-between rounded-lg border border-white/10 px-4 py-3"
            >
              <div>
                <p className="font-medium">Player {n}</p>
                <p className="text-xs text-white/50">
                  G{String(n).repeat(5)}…{String(n).repeat(4)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm font-semibold">500 XLM</p>
                <p className="text-xs text-white/50">round 1</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
