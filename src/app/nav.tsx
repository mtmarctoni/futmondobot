import Link from "next/link";

const links: { href: string; label: string }[] = [
  { href: "/", label: "Today" },
  { href: "/lineup", label: "Lineup" },
  { href: "/market", label: "Market" },
  { href: "/clauses", label: "Clauses" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  return (
    <header className="border-b border-zinc-800">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-3">
        <Link href="/" className="font-semibold tracking-tight">
          ⚽ FutmondoBot
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-md px-3 py-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
