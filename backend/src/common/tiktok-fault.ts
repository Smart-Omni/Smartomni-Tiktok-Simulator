import { HttpException } from '@nestjs/common';

/**
 * Simulator TEST-FAULT kinds. contracts/fixtures/errors.json lists invalid_input, token_expired, missing_scope and
 * bad_signature as undocumented test faults; every other kind is a SIMULATOR-ONLY addition (no documented TikTok equivalent).
 */
export type FaultKind =
  | 'invalid_input'
  | 'token_expired'
  | 'missing_scope'
  | 'bad_signature'
  // simulator-only additions
  | 'stale_timestamp'
  | 'unknown_app_key'
  | 'invalid_app_credentials'
  | 'token_invalid'
  | 'authorization_revoked'
  | 'shop_cipher_mismatch'
  | 'auth_code_invalid'
  | 'auth_code_expired'
  | 'auth_code_used'
  | 'refresh_token_invalid'
  | 'refresh_token_expired'
  | 'product_not_found'
  | 'unsupported_operation'
  | 'conversation_not_found'
  | 'cannot_send_message'
  | 'order_not_found'
  | 'package_not_found'
  | 'warehouse_not_found'
  | 'delivery_option_not_found'
  | 'package_not_arranged'
  | 'order_not_shippable'
  | 'coupon_not_found'
  | 'aftersale_not_found'
  | 'invalid_decision'
  | 'aftersale_conflict';

const IN_CONTRACT_FIXTURES: FaultKind[] = ['invalid_input', 'token_expired', 'missing_scope', 'bad_signature'];

/**
 * Sentinel envelope `code`. TikTok error code VALUES are undocumented, so none is invented: this negative integer is
 * simulator-owned and never a TikTok code. Consumers must branch on HTTP status + `simulator_fault.kind`, not on this value.
 */
export const SIMULATOR_FAULT_CODE = -1;

export class TiktokFault extends HttpException {
  constructor(
    status: number,
    readonly kind: FaultKind,
    message: string,
  ) {
    super({ kind, message }, status);
  }

  get inFixtures(): boolean {
    return IN_CONTRACT_FIXTURES.includes(this.kind);
  }
}
