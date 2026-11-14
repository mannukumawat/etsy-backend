import { isoDate } from '../../shared/utils/dates.js';

export interface BankAccountRow {
  id: string; customer_id: string; account_holder_name: string;
  account_number_encrypted: string; account_number_last4: string;
  ifsc_code: string; is_active: number; created_at: Date;
}

export function toPublicBankAccount(r: BankAccountRow) {
  return {
    id: r.id,
    accountHolderName: r.account_holder_name,
    accountNumberMasked: `•••• ${r.account_number_last4}`,
    ifscCode: r.ifsc_code,
    createdAt: isoDate(r.created_at)!,
  };
}
