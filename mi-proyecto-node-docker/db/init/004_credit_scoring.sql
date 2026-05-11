-- 004_credit_scoring.sql
-- Agrega columnas de scoring crediticio a applicants
-- y campos de perfil adicionales que el formulario de evaluación recopila

-- Campos de perfil del cliente (datos que llena el formulario)
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS years_employed NUMERIC(5,1);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS cnt_children INTEGER DEFAULT 0;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS cnt_fam_members INTEGER DEFAULT 1;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS own_car BOOLEAN DEFAULT FALSE;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS own_realty BOOLEAN DEFAULT FALSE;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS education_type TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS family_status TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS housing_type TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS total_existing_debt NUMERIC(14,2) DEFAULT 0;

-- Resultados del scoring (los llena el sistema)
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS credit_score INTEGER;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS risk_category TEXT;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS assigned_rate NUMERIC(6,4);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS probability_of_default NUMERIC(8,6);
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS scored_at TIMESTAMP;
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS scoring_approved BOOLEAN;
