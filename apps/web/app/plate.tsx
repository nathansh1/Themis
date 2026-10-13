import type { ReactNode } from "react";

export default function Plate({
  numeral,
  title,
  children,
  className = "",
}: {
  numeral: string;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`hairline border bg-background/60 p-6 ${className}`}>
      <header className="mb-5 flex items-baseline gap-3">
        <span className="font-display text-xs text-foreground/40">{numeral}</span>
        <h2 className="font-display text-sm font-semibold uppercase tracking-[0.22em]">{title}</h2>
        <span className="hairline ml-2 flex-1 translate-y-[-0.2em] border-t" />
      </header>
      {children}
    </section>
  );
}
