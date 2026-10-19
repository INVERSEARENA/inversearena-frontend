import Link from "next/link";

const SECTIONS = [
  {
    href: "/dev/choice-cards",
    title: "Choice cards",
    desc: "Heads/Tails selection cards across default, selected, and disabled states.",
  },
  {
    href: "/dev/modals",
    title: "Modals",
    desc: "Join-arena, stake, pool-success and share modal chrome with mocked flows.",
  },
  {
    href: "/dev/arena-overlays",
    title: "Arena overlays",
    desc: "Tension bar, quorum progress, pre-game intel, and waiting-state overlays.",
  },
  {
    href: "/dev/lobby",
    title: "Lobby states",
    desc: "Empty, joining, ready, and eliminated lobby participant states.",
  },
  {
    href: "/dev/pool-success-demo",
    title: "Pool success demo",
    desc: "Migrated from /pool-success-demo — success-callout demo page.",
  },
  {
    href: "/dev/share-test",
    title: "Share test",
    desc: "Migrated from /arena-v2/share-test — share-card preview.",
  },
];

export default function DevGalleryIndex() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {SECTIONS.map((section) => (
        <Link
          key={section.href}
          href={section.href}
          className="rounded-xl border border-white/10 bg-white/[0.03] p-5 transition hover:border-[#63b3ed]/50"
        >
          <h2 className="text-base font-semibold text-[#63b3ed]">{section.title}</h2>
          <p className="mt-2 text-sm text-white/60">{section.desc}</p>
        </Link>
      ))}
    </div>
  );
}
