import type { ReactNode } from 'react';

/**
 * Drop-in Test Console tabs: `src/features/<name>.console.tsx` default-exports a ConsoleTab[] and Vite picks it up
 * (no edit of the shared console page). The legacy /buyer and /seller tab files were replaced by the TikTok Shop UI.
 */
export interface ConsoleContext {
  shopId: string;
}
export interface ConsoleTab {
  path: string;
  label: string;
  order: number;
  render: (ctx: ConsoleContext) => ReactNode;
}

function collect<T extends { order: number }>(modules: Record<string, { default: T[] }>): T[] {
  return Object.values(modules)
    .flatMap((m) => m.default)
    .sort((a, b) => a.order - b.order);
}

export const consoleTabs = (): ConsoleTab[] => collect<ConsoleTab>(import.meta.glob('./*.console.tsx', { eager: true }));
