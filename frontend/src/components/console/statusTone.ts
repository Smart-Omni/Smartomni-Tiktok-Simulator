/** Presentation only: keep the API status text and transition logic intact. */
export function statusTone(status: string): 'info' | 'success' | 'warning' | 'danger' | 'neutral' {
  const value = status.toUpperCase();
  if (/CANCEL|REJECT|FAIL|REVOK|ERROR|DEAD|LOSS|EXPIRED/.test(value)) return 'danger';
  if (/UNPAID|AWAITING|PENDING|NOT_STARTED/.test(value)) return 'warning';
  if (/IN_TRANSIT|IN_PROGRESS|PARTIALLY_SHIPPING|BUYER_SHIPPED|IN_ARBITRATION/.test(value)) return 'info';
  if (/DELIVERED|COMPLETED|COMPLETE|SUCCESS|SUCCEEDED|ARBITRATION_WIN/.test(value) || ['ACTIVE', 'ONGOING', 'NORMAL'].includes(value)) return 'success';
  return 'neutral';
}
