/** Placeholder for a page of the new UI that a later step of docs/tiptopshop-plan.md builds. */
export function ComingSoon({ title, hideTitle = false }: { title: string; hideTitle?: boolean }) {
  return (
    <section className="flex min-h-[320px] flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line bg-white p-10 text-center">
      {!hideTitle && <h1 className="text-xl font-semibold text-ink">{title}</h1>}
      <p className="text-sm text-muted-foreground">Coming soon.</p>
    </section>
  );
}
