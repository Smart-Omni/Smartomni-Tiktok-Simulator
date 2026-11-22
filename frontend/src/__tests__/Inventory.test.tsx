import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InventoryHistoryView } from '../features/inventory.console';

afterEach(cleanup);

describe('InventoryHistoryView', () => {
  it('shows before/after, flags no-op retries and API attempts that never got an answer', () => {
    render(
      <InventoryHistoryView
        data={{
          changes: [
            { seq: 2, sku: 'S1', sellerSku: 'TEE-M', warehouse: 'W1', warehouseName: 'Kho HN', before: 12, after: 12, source: 'API', noop: true, requestId: 'req-2', note: '', at: '2026-10-15T01:00:00Z' },
            { seq: 1, sku: 'S1', sellerSku: 'TEE-M', warehouse: 'W1', warehouseName: 'Kho HN', before: 40, after: 12, source: 'API', noop: false, requestId: 'req-1', note: '', at: '2026-10-15T00:59:00Z' },
          ],
          attempts: [{ seq: 1, product: 'P1', outcome: 'TIMEOUT_AFTER_WRITE', itemsTotal: 1, itemsApplied: 1, itemsFailed: 0, requestId: 'req-1', at: '2026-10-15T00:59:00Z' }],
        }}
      />,
    );
    expect(screen.getByText('no-op retry')).toBeTruthy();
    expect(screen.getByText('40')).toBeTruthy();
    expect(screen.getByText('TIMEOUT_AFTER_WRITE')).toBeTruthy();
  });

  it('explains empty history', () => {
    render(<InventoryHistoryView data={{ changes: [], attempts: [] }} />);
    expect(screen.getByText('No stock changes yet.')).toBeTruthy();
    expect(screen.getByText('No inventory update requests yet.')).toBeTruthy();
  });
});
