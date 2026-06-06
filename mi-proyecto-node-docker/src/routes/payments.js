const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth')
const { assertLoanOwner } = require('../utils/ownership')
const pool = require('../../db');

const {
  WebpayPlus,
  IntegrationCommerceCodes,
  IntegrationApiKeys
} = require('transbank-sdk');

const { buildInstallmentSchedule } = require('../utils/installments');

// Build a WebpayPlus transaction instance for integration or production
function buildWebpayTransaction() {
  const env = (process.env.TB_ENV || '').toUpperCase();
  const commerceCode =
    process.env.TB_COMMERCE_CODE || IntegrationCommerceCodes.WEBPAY_PLUS;
  const apiKey =
    process.env.TB_API_KEY || IntegrationApiKeys.WEBPAY;

  if (env === 'PROD' || env === 'PRODUCTION') {
    return WebpayPlus.Transaction.buildForProduction(commerceCode, apiKey);
  }

  // Default: integration environment
  return WebpayPlus.Transaction.buildForIntegration(commerceCode, apiKey);
}

const webpayTransaction = buildWebpayTransaction();

async function ensureInstallmentPaymentsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS loan_installment_payments (
      id SERIAL PRIMARY KEY,
      loan_request_id INTEGER NOT NULL REFERENCES loan_requests(id) ON DELETE CASCADE,
      installment INTEGER NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CLP',
      status TEXT NOT NULL DEFAULT 'INITIATED',
      transbank_token TEXT,
      transbank_buy_order TEXT,
      transbank_session_id TEXT,
      response JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMP
    )
  `);

  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_installments_loan ON loan_installment_payments(loan_request_id)'
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_installments_token ON loan_installment_payments(transbank_token)'
  );
}

/**
 * GET /api/payments/loans/:id
 * Devuelve el historial de pagos registrados para un pr&eacute;stamo.
 */
router.get('/loans/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'BAD_LOAN_ID' });
  }

  try {
    await ensureInstallmentPaymentsTable();
    const ownership = await assertLoanOwner(pool, id, req.auth.applicantId)
    if (!ownership.ok) {
    return res.status(ownership.status).json({ error: ownership.error })
    }
    const { rows } = await pool.query(
      `SELECT id, loan_request_id, installment, amount, currency,
              status, transbank_token, transbank_buy_order,
              created_at, updated_at, paid_at
         FROM loan_installment_payments
        WHERE loan_request_id = $1
        ORDER BY created_at DESC, installment ASC`,
      [id]
    );

    return res.json(rows);
  } catch (err) {
    console.error('[GET /api/payments/loans/:id] ERROR:', err);
    return res.status(500).json({ error: 'PAYMENTS_HISTORY_ERROR' });
  }
});

// Utilidad para determinar la cuota "próxima" impaga
async function findNextUnpaidInstallment(loanId, loan) {
  const schedule = buildInstallmentSchedule(loan);
  if (!schedule.length) return null;

  const paidRes = await pool.query(
    `SELECT installment
       FROM loan_installment_payments
      WHERE loan_request_id = $1
        AND status IN ('AUTHORIZED','PAID')`,
    [loanId]
  );

  const paidSet = new Set(
    paidRes.rows.map((r) => Number(r.installment)).filter((n) => Number.isFinite(n))
  );

  const now = new Date();
  const candidates = schedule.filter((row) => !paidSet.has(row.installment));
  if (!candidates.length) return null;

  candidates.sort(
    (a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
  );

  return (
    candidates.find((r) => new Date(r.dueDate) >= now) ||
    candidates[0] ||
    null
  );
}

/**
 * POST /api/payments/loans/:id/installments/next
 * Inicia el pago de la cuota próxima de un préstamo activo usando Webpay Plus.
 */
router.post('/loans/:id/installments/next', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'BAD_LOAN_ID' });
  }

  try {
    await ensureInstallmentPaymentsTable();
    const ownership = await assertLoanOwner(pool, id, req.auth.applicantId)
    if (!ownership.ok) {
    return res.status(ownership.status).json({ error: ownership.error })
    }

    const loanResult = await pool.query(
  `SELECT id, amount, term_months, monthly_rate, monthly_payment, status, created_at
     FROM loan_requests
    WHERE id = $1
      AND applicant_id = $2`,
  [id, req.auth.applicantId]
)

    if (!loanResult.rows.length) {
      return res.status(404).json({ error: 'LOAN_NOT_FOUND' });
    }

    const loan = loanResult.rows[0];
    const allowedStatuses = ['ACTIVE', 'DISBURSED', 'CONTRACT_SIGNED'];
    if (!allowedStatuses.includes(String(loan.status))) {
      return res.status(400).json({ error: 'LOAN_NOT_ACTIVE' });
    }

    const nextInstallment = await findNextUnpaidInstallment(id, loan);
    if (!nextInstallment) {
      return res.status(400).json({ error: 'NO_INSTALLMENTS_LEFT' });
    }

    // Monto redondeado al entero más cercano en CLP
    const amount = Math.round(Number(nextInstallment.totalPayment || 0));
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'INVALID_AMOUNT' });
    }

    const buyOrder = `LR${loan.id}-I${nextInstallment.installment}-${Date.now()}`;
    const sessionId = `LR${loan.id}-I${nextInstallment.installment}`;

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const returnUrl = `${baseUrl}/api/payments/commit`;

    const wpResponse = await webpayTransaction.create(
      buyOrder,
      sessionId,
      amount,
      returnUrl
    );

    await pool.query(
      `INSERT INTO loan_installment_payments
        (loan_request_id, installment, amount, currency, status,
         transbank_token, transbank_buy_order, transbank_session_id, response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        loan.id,
        nextInstallment.installment,
        amount,
        'CLP',
        'INITIATED',
        wpResponse.token,
        buyOrder,
        sessionId,
        JSON.stringify(wpResponse)
      ]
    );

    return res.json({
      ok: true,
      loanId: loan.id,
      installment: nextInstallment.installment,
      amount,
      token: wpResponse.token,
      url: wpResponse.url
    });
  } catch (err) {
    console.error('[POST /api/payments/loans/:id/installments/next] ERROR:', err);
    return res.status(500).json({ error: 'PAYMENT_INIT_ERROR' });
  }
});

// Handler compartido para GET/POST /api/payments/commit
async function handleCommit(req, res) {
  const token =
    (req.body && (req.body.token_ws || req.body.TBK_TOKEN)) ||
    req.query.token_ws ||
    req.query.TBK_TOKEN ||
    null;

  if (!token) {
    return res.status(400).send('Token de pago no recibido.');
  }

  try {
    await ensureInstallmentPaymentsTable();

    const payResult = await pool.query(
      `SELECT *
         FROM loan_installment_payments
        WHERE transbank_token = $1
        LIMIT 1`,
      [token]
    );

    if (!payResult.rows.length) {
      return res.status(404).send('No se encontró el pago asociado al token.');
    }

    const paymentRow = payResult.rows[0];

    let commitResponse;
    let status = 'FAILED';
    let success = false;

    try {
      commitResponse = await webpayTransaction.commit(token);
      // En Webpay Plus REST un pago exitoso suele tener response_code === 0
      if (commitResponse && commitResponse.response_code === 0) {
        status = 'AUTHORIZED';
        success = true;
      }
    } catch (commitErr) {
      console.error('[WebpayPlus.commit] ERROR:', commitErr);
      status = 'FAILED';
      commitResponse = { error: String(commitErr.message || commitErr) };
    }

    await pool.query(
      `UPDATE loan_installment_payments
          SET status = $1,
              response = $2,
              updated_at = NOW(),
              paid_at = CASE WHEN $3 THEN NOW() ELSE paid_at END
        WHERE id = $4`,
      [status, JSON.stringify(commitResponse || {}), success, paymentRow.id]
    );

    const viewModel = {
      title: success ? 'Pago exitoso' : 'Pago no completado',
      success,
      loanId: paymentRow.loan_request_id,
      installment: paymentRow.installment,
      amount: paymentRow.amount,
      raw: commitResponse || {}
    };

    return res.render('payment_result', viewModel);
  } catch (err) {
    console.error('[COMMIT /api/payments/commit] ERROR:', err);
    return res.status(500).send('Error al confirmar el pago.');
  }
}

router.post('/commit', express.urlencoded({ extended: true }), handleCommit);
router.get('/commit', handleCommit);

module.exports = router;
