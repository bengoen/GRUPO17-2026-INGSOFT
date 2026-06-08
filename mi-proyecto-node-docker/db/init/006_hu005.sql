-- db/init/006_hu005.sql
CREATE TABLE IF NOT EXISTS installments (
  id SERIAL PRIMARY KEY,
  loan_request_id INTEGER NOT NULL REFERENCES loan_requests(id) ON DELETE CASCADE,
  installment_num INTEGER NOT NULL,
  due_date DATE NOT NULL,
  base_amount NUMERIC(12,2) NOT NULL,
  interest_amount NUMERIC(12,2) NOT NULL,
  insurance_amount NUMERIC(12,2) NOT NULL,
  fee_amount NUMERIC(12,2) NOT NULL,
  total_payment NUMERIC(12,2) NOT NULL,
  penalty_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  paid_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (loan_request_id, installment_num)
);

CREATE INDEX IF NOT EXISTS idx_installments_loan ON installments(loan_request_id);
