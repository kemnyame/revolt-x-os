-- Central finance reversal support for student receipts.

ALTER TABLE finance_student_receipts
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by_os_user_id uuid,
  ADD COLUMN IF NOT EXISTS reversal_reason varchar(1200),
  ADD COLUMN IF NOT EXISTS reversal_entry_id uuid REFERENCES finance_journal_entries(id);

CREATE INDEX IF NOT EXISTS finance_student_receipts_reversal_idx
  ON finance_student_receipts(organisation_id,status,reversed_at DESC);

CREATE INDEX IF NOT EXISTS payments_finance_receipt_void_idx
  ON payments(finance_receipt_id,voided_at);
