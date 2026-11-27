import { useState, type ReactNode } from 'react';
import { FlaskConical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

/**
 * Simulator test tools inside Seller Center (docs/seller-center-test-tools-plan.md). They call /test-admin and the
 * simulator-only APIs, which TikTok Seller Center does not have, so every block carries the TEST label.
 */
export function TestBadge({ className }: { className?: string }) {
  return <span className={cn('seller-test-badge', className)}>TEST</span>;
}

export type TestScope = 'shop' | 'all';
const scopeText: Record<TestScope, string> = { shop: 'This shop only', all: 'All shops' };

export function TestScopeNote({ scope }: { scope: TestScope }) {
  return <span className="seller-test-scope">{scopeText[scope]}</span>;
}

/**
 * Lets the Test Console panels (pages/console, features/*.console.tsx) render outside the console: their styles live in the
 * legacy layer and only apply inside `.app` / `.admin-console` / `.admin-panel`. seller.css undoes the console page layout.
 */
export function TestToolsFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('app seller-test-tools', className)}>
      <div className="admin-console seller-test-tools-console">
        <div className="admin-panel admin-register-panel">{children}</div>
      </div>
    </div>
  );
}

export interface TestTab {
  label: string;
  scope: TestScope;
  render: () => ReactNode;
}

interface SheetProps {
  title: string;
  description: string;
  tabs: TestTab[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: string;
}

/** Right-hand sheet with one tab per test tool; only the active tab is mounted, so its polling stops when hidden. */
export function TestToolsSheet({ title, description, tabs, open, onOpenChange, initialTab }: SheetProps) {
  const [tab, setTab] = useState(initialTab ?? tabs[0]?.label);
  const active = tabs.find((t) => t.label === tab) ?? tabs[0];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="theme-seller seller-test-sheet font-sans w-full sm:max-w-3xl">
        <SheetHeader className="seller-test-sheet-header">
          <SheetTitle className="flex items-center gap-2"><FlaskConical size={16} aria-hidden="true" />{title}<TestBadge /></SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {tabs.length > 1 && (
          <Tabs value={active?.label} onValueChange={setTab} className="px-4">
            <TabsList variant="line" aria-label={`${title} tools`}>
              {tabs.map((t) => <TabsTrigger key={t.label} value={t.label}>{t.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        )}
        {active && (
          <div className="seller-test-sheet-body" role="region" aria-label={active.label}>
            <TestScopeNote scope={active.scope} />
            <TestToolsFrame>{active.render()}</TestToolsFrame>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** "Test tools" button for a Seller Center page toolbar. `onClose` lets the page reload what the tools changed. */
export function TestToolsButton({ title, description, tabs, onClose, className }: { title: string; description: string; tabs: TestTab[]; onClose?: () => void; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" className={cn('seller-test-button', className)} onClick={() => setOpen(true)}>
        <FlaskConical aria-hidden="true" />Test tools
      </Button>
      {open && <TestToolsSheet title={title} description={description} tabs={tabs} open onOpenChange={(o) => { if (!o) { setOpen(false); onClose?.(); } }} />}
    </>
  );
}

/** Right-aligned row above a page's own content that holds its Test tools button. */
export function TestToolbar({ children }: { children: ReactNode }) {
  return <div className="seller-test-toolbar">{children}</div>;
}
