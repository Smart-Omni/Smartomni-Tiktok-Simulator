import { api, ApiError } from '../../lib/api';

export const disputeStatuses = ['DISPUTE_PENDING_REVIEW', 'DISPUTE_APPROVED', 'DISPUTE_REJECTED'] as const;
export type DisputeStatus = typeof disputeStatuses[number];
export interface DisputeRecord {
  disputeId: string;
  orderId: string;
  returnId?: string;
  shopId: string;
  status: DisputeStatus;
  reason?: string;
  compensation?: Record<string, unknown> & { amount: number; currency: string };
  adjustment?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export interface DisputeInput {
  shop_id: string;
  order_id: string;
  dispute_id?: string;
  return_id?: string;
  status: DisputeStatus;
  reason?: string;
  compensation_amount?: number;
  currency?: string;
  webhook_url?: string;
}
export interface DisputeTriggerResult {
  dispute_id: string;
  dispute_status: DisputeStatus;
  webhook_enqueued: boolean;
  webhook_sent: boolean;
  target_url?: string;
}
const path = '/api/v2/simulator/dispute';
async function request<T>(suffix = '', body?: DisputeInput): Promise<T> {
  const result = await api<{ code: number; message: string; data: T; request_id?: string }>(`${path}${suffix}`, body ? { method: 'POST', body } : {});
  if (result.code !== 0 || result.data == null) throw new ApiError(result.message || 'Invalid dispute response', 200, result.request_id);
  return result.data;
}
export const listDisputes = () => request<{ disputes: DisputeRecord[] }>();
export const getDispute = (id: string) => request<DisputeRecord>(`/${encodeURIComponent(id)}`);
export const triggerDispute = (body: DisputeInput) => request<DisputeTriggerResult>('/trigger', body);
export const disputeLabel = (status: DisputeStatus) => ({ DISPUTE_PENDING_REVIEW: 'Pending review', DISPUTE_APPROVED: 'Approved', DISPUTE_REJECTED: 'Rejected' })[status];
