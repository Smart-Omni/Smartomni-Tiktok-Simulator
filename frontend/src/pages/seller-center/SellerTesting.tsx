import { useSearchParams } from 'react-router-dom';
import { SellerCard } from '@/components/seller/SellerUi';
import { TestBadge, TestScopeNote, TestToolsFrame, type TestTab } from '@/components/seller/TestTools';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/lib/auth';
import { ClockPanel } from '@/pages/console/ClockPanel';
import { StatusPanel } from '@/pages/console/StatusPanel';

/** A Testing page: tabs kept in `?tab=` so a tool can be linked directly. */
function TestingPage({ title, description, warning, tabs }: { title: string; description: string; warning?: string; tabs: TestTab[] }) {
  const [params, setParams] = useSearchParams();
  const active = tabs.find((t) => t.label === params.get('tab')) ?? tabs[0];
  return (
    <div className="flex flex-col gap-4">
      <div><h1 className="flex items-center gap-2">{title}<TestBadge /></h1><p className="text-sm">{description}</p></div>
      {warning ? <div className="seller-test-warning" role="note">{warning}</div> : null}
      <SellerCard className="p-5">
        {tabs.length > 1 && (
          <Tabs value={active.label} onValueChange={(v) => setParams(v === tabs[0].label ? {} : { tab: v }, { replace: true })}>
            <TabsList variant="line" className="mb-3" aria-label={`${title} tools`}>
              {tabs.map((t) => <TabsTrigger key={t.label} value={t.label}>{t.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        )}
        <div role="region" aria-label={active.label}>
          <TestScopeNote scope={active.scope} />
          <TestToolsFrame key={active.label}>{active.render()}</TestToolsFrame>
        </div>
      </SellerCard>
    </div>
  );
}

/** Integration tests of the TikTok-shaped API: authorization, webhooks, HTTP log and fault injection. */
export function SellerTestingIntegration() {
  const { seller } = useAuth();
  if (!seller) return null;
  const tabs: TestTab[] = [];
  return <TestingPage title="Integration testing" description="Test how SmartOmni handles tokens, webhooks and API faults for this shop." tabs={tabs.length ? tabs : [{ label: 'Integration', scope: 'shop', render: () => null }]} />;
}

/** Simulator-wide tools. Reset stays in the Test Console only (decided 2026-11-27). */
export function SellerTestingSystem() {
  const { seller } = useAuth();
  if (!seller) return null;
  const tabs: TestTab[] = [
    { label: 'Status & seed', scope: 'all', render: () => <StatusPanel onSeeded={() => undefined} /> },
    { label: 'Business clock', scope: 'all', render: () => <ClockPanel /> },
  ];
  return <TestingPage title="Simulator system" description="Simulator health, seed data and the business clock." warning="These tools affect every shop. Resetting data is only available in the Test Console." tabs={tabs} />;
}
