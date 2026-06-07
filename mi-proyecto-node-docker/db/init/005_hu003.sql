-- HU003: Idempotencia de la firma del contrato
-- Garantiza a nivel de base de datos que un prestamo no pueda registrar
-- mas de un evento CONTRACT_SIGNED, aunque la logica de aplicacion falle.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_signed_once
  ON loan_request_events (loan_request_id)
  WHERE event_type = 'CONTRACT_SIGNED';
