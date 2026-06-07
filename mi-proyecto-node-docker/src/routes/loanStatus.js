// src/routes/loanStatus.js
const express = require('express');
const { buildInstallmentSchedule, summarizeSchedule } = require('../utils/installments');
const router = express.Router();
const { requireAuth } = require('../middleware/auth')
const { assertLoanOwner } = require('../utils/ownership')

module.exports = (pool) => {
  /**
   * GET /api/loan-requests?applicantId=#
   * Lista solicitudes (mapea term_months -> term)
   */
  router.get('/loan-requests', requireAuth, async (req, res) => {
  const applicantId = req.auth.applicantId
    try {
      const { rows } = await pool.query(
        `SELECT id, applicant_id, amount,
                term_months AS term,
                monthly_rate, monthly_payment,
                status, updated_at
           FROM loan_requests
          WHERE applicant_id = $1
          ORDER BY updated_at DESC`,
        [applicantId]
      );
      return res.json(rows);
    } catch (err) {
      console.error('[GET /loan-requests] DB_ERROR:', err);
      return res.status(500).json({ error: 'DB_ERROR' });
    }
  });

  /**
   * GET /api/loan-requests/:id/status
   * Estado actual + próximas acciones
   */
  router.get('/loan-requests/:id/status',requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'BAD_REQUEST' });

    try {
      const ownership = await assertLoanOwner(pool, id, req.auth.applicantId)
      if (!ownership.ok) {
      return res.status(ownership.status).json({ error: ownership.error })
      }
      const { rows } = await pool.query(
        `SELECT id, status, updated_at,
           CASE status
             WHEN 'PENDING_EVAL'     THEN ARRAY['WAIT']
             WHEN 'APPROVED'         THEN ARRAY['REVIEW_CONTRACT']
             WHEN 'REJECTED'         THEN ARRAY[]::text[]
             WHEN 'CONTRACT_PENDING' THEN ARRAY['REVIEW_CONTRACT']
             WHEN 'CONTRACT_SIGNED'  THEN ARRAY['VIEW_INSTALLMENTS']
             WHEN 'ACTIVE'           THEN ARRAY['VIEW_INSTALLMENTS']
             WHEN 'DISBURSED'        THEN ARRAY['VIEW_INSTALLMENTS']
           END AS next_actions
         FROM loan_requests
        WHERE id = $1`,
        [id]
      );
      if (!rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
      return res.json(rows[0]);
    } catch (err) {
      console.error('[GET /loan-requests/:id/status] DB_ERROR:', err);
      return res.status(500).json({ error: 'DB_ERROR' });
    }
  });

  /**
   * GET /api/loan-requests/:id/timeline
   * Línea de tiempo de eventos
   */
  router.get('/loan-requests/:id/timeline', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'BAD_REQUEST' });

    try {
      const ownership = await assertLoanOwner(pool, id, req.auth.applicantId)
      if (!ownership.ok) {
      return res.status(ownership.status).json({ error: ownership.error })
      }
      const { rows } = await pool.query(
        `SELECT event_type, event_data, created_at
           FROM loan_request_events
          WHERE loan_request_id = $1
          ORDER BY created_at ASC`,
        [id]
      );
      return res.json(rows);
    } catch (err) {
      console.error('[GET /loan-requests/:id/timeline] DB_ERROR:', err);
      return res.status(500).json({ error: 'DB_ERROR' });
    }
  });

  /**
   * GET /api/loan-requests/:id/installments
   * Devuelve cuadro de cuotas y resumen
   */
  router.get('/loan-requests/:id/installments', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'BAD_REQUEST' });

    try {
      const ownership = await assertLoanOwner(pool, id, req.auth.applicantId)
      if (!ownership.ok) {
      return res.status(ownership.status).json({ error: ownership.error })
      }
      const { rows } = await pool.query(
        `SELECT id, amount, term_months, monthly_rate, monthly_payment, status, created_at
           FROM loan_requests
          WHERE id = $1`,
        [id]
      );
      if (!rows.length) return res.status(404).json({ error: 'NOT_FOUND' });

      const loan = rows[0];
      const schedule = buildInstallmentSchedule(loan);
      const summary = summarizeSchedule(schedule);

      // Intentar marcar cuotas ya pagadas (si existe tabla de pagos)
      let paidInstallments = [];
      try {
        const paidRes = await pool.query(
          `SELECT installment
             FROM loan_installment_payments
            WHERE loan_request_id = $1
              AND status IN ('AUTHORIZED','PAID')`,
          [id]
        );
        paidInstallments = paidRes.rows.map((r) => Number(r.installment));
      } catch (innerErr) {
        const msg = String(innerErr.message || innerErr);
        // Si la tabla aún no existe, seguimos sin marcar pagos
        if (!msg.includes('relation') || !msg.includes('loan_installment_payments')) {
          console.error('[GET /loan-requests/:id/installments] PAYMENTS_ERROR:', innerErr);
        }
        paidInstallments = [];
      }

      const paidSet = new Set(
        paidInstallments.filter((n) => Number.isFinite(n) && n > 0)
      );

      const enrichedSchedule = schedule.map((row) => ({
        ...row,
        paid: paidSet.has(row.installment)
      }));

      const now = new Date();
      const nextRow =
        enrichedSchedule.find((r) => !r.paid && new Date(r.dueDate) >= now) ||
        enrichedSchedule.find((r) => !r.paid) ||
        null;

      return res.json({
        loan,
        schedule: enrichedSchedule,
        summary,
        paidInstallments: Array.from(paidSet),
        nextInstallment: nextRow ? nextRow.installment : null
      });
    } catch (err) {
      console.error('[GET /loan-requests/:id/installments] DB_ERROR:', err);
      return res.status(500).json({ error: 'DB_ERROR' });
    }
  });

  /**
   * PATCH /api/loan-requests/:id/status
   * Cambia el estado y encola una notificación (mock)
   */
  router.patch('/loan-requests/:id/status', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body;

    const allowed = [
      'PENDING_EVAL', 'APPROVED', 'REJECTED',
      'CONTRACT_PENDING', 'CONTRACT_SIGNED',
      'ACTIVE', 'DISBURSED'
    ];
    if (!Number.isFinite(id) || !allowed.includes(status)) {
      return res.status(400).json({ error: 'BAD_REQUEST', allowed });
    }

    try {
      await pool.query('BEGIN');

      // UPDATE con cast explícito al ENUM
      const upd = await pool.query(
        `UPDATE loan_requests
            SET status = $1::loan_status
          WHERE id = $2
          RETURNING id`,
        [status, id]
      );
      if (!upd.rowCount) {
        await pool.query('ROLLBACK');
        return res.status(404).json({ error: 'NOT_FOUND' });
      }

      // Encolar notificación (casteando $2 a text para jsonb_build_object)
      await pool.query(
        `INSERT INTO notifications(loan_request_id, channel, template, payload)
         VALUES ($1, 'EMAIL', 'status_changed',
                 jsonb_build_object('newStatus', $2::text))`,
        [id, status]
      );

      await pool.query('COMMIT');
      return res.json({ ok: true });
    } catch (err) {
      await pool.query('ROLLBACK');
      console.error('[PATCH /loan-requests/:id/status] DB_ERROR:', err);
      return res.status(500).json({ error: 'DB_ERROR' });
    }
  });

  /**
   * POST /api/loan-requests/:id/contract/review
   * Marca que el cliente revisó el contrato (evento informativo)
   */
  router.post('/loan-requests/:id/contract/review', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'BAD_REQUEST' });

    try {
      const ownership = await assertLoanOwner(pool, id, req.auth.applicantId)
      if (!ownership.ok) {
      return res.status(ownership.status).json({ error: ownership.error })
      }
      const { rowCount } = await pool.query(
        'INSERT INTO loan_request_events(loan_request_id, event_type, event_data) VALUES ($1, $2, $3)',
        [id, 'CONTRACT_REVIEWED', JSON.stringify({ source: 'WEB', userAgent: req.headers['user-agent'] || null })]
      );
      if (!rowCount) return res.status(404).json({ error: 'NOT_FOUND' });
      return res.json({ ok: true });
    } catch (err) {
      console.error('[POST /loan-requests/:id/contract/review] DB_ERROR:', err);
      return res.status(500).json({ error: 'DB_ERROR' });
    }
  });

  /**
   * POST /api/loan-requests/:id/contract/start-sign
   * Simula envío del contrato al sistema de firma digital y pasa a CONTRACT_PENDING
   */
  router.post('/loan-requests/:id/contract/start-sign', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'BAD_REQUEST' });

    try {
      const ownership = await assertLoanOwner(pool, id, req.auth.applicantId)
      if (!ownership.ok) {
      return res.status(ownership.status).json({ error: ownership.error })
      }
      await pool.query('BEGIN');

      const current = await pool.query(
        'SELECT status FROM loan_requests WHERE id = $1',
        [id]
      );
      if (!current.rows.length) {
        await pool.query('ROLLBACK');
        return res.status(404).json({ error: 'NOT_FOUND' });
      }

      const currentStatus = current.rows[0].status;
      const allowedStart = ['APPROVED', 'CONTRACT_PENDING', 'ACTIVE'];
      if (!allowedStart.includes(currentStatus)) {
        await pool.query('ROLLBACK');
        return res.status(400).json({ error: 'INVALID_STATE', currentStatus });
      }

      await pool.query(
        'INSERT INTO loan_request_events(loan_request_id, event_type, event_data) VALUES ($1, $2, $3)',
        [id, 'CONTRACT_SENT_TO_SIGNATURE', JSON.stringify({ provider: 'MockSign', channel: 'WEB' })]
      );

      if (currentStatus !== 'CONTRACT_PENDING' && currentStatus !== 'ACTIVE') {
        await pool.query(
          `UPDATE loan_requests
              SET status = $1::loan_status
            WHERE id = $2`,
          ['CONTRACT_PENDING', id]
        );
      }

      await pool.query('COMMIT');
      return res.json({
        ok: true,
        message: 'Contrato enviado al sistema de firma digital (simulado). Sigue los pasos de verificación para completar la firma.'
      });
    } catch (err) {
      await pool.query('ROLLBACK');
      console.error('[POST /loan-requests/:id/contract/start-sign] DB_ERROR:', err);
      return res.status(500).json({ error: 'DB_ERROR' });
    }
  });

  /**
   * POST /api/loan-requests/:id/contract/confirm-sign
   * Simula confirmación de firma digital y activa el préstamo (estado ACTIVE)
   */
  router.post('/loan-requests/:id/contract/confirm-sign', requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const code = (req.body && req.body.code ? String(req.body.code).trim() : '') || null;
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'BAD_REQUEST' });
    if (!code) return res.status(400).json({ error: 'CODE_REQUIRED' });
    // se mantiene el acceso con el predeterminado, pero se hace robusta la confirmación al no validar otro código
    const EXPECTED_CODE = '123456';
    if (code !== EXPECTED_CODE) {
      return res.status(400).json({ error: 'INVALID_SIGNATURE_CODE' });
    }

    try {
      const ownership = await assertLoanOwner(pool, id, req.auth.applicantId)
      if (!ownership.ok) {
      return res.status(ownership.status).json({ error: ownership.error })
      }
      await pool.query('BEGIN');

      const current = await pool.query(
        'SELECT status FROM loan_requests WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (!current.rows.length) {
        await pool.query('ROLLBACK');
        return res.status(404).json({ error: 'NOT_FOUND' });
      }
      const currentStatus = current.rows[0].status;
      if (currentStatus === 'ACTIVE') {
        await pool.query('ROLLBACK');
        return res.json({ ok: true, alreadyActive: true });
      }

      const allowedConfirm = ['APPROVED', 'CONTRACT_PENDING'];
      if (!allowedConfirm.includes(currentStatus)) {
        await pool.query('ROLLBACK');
        return res.status(400).json({ error: 'INVALID_STATE', currentStatus });
      }

      // Registrar firma exitosa y activación del préstamo
      await pool.query(
        'INSERT INTO loan_request_events(loan_request_id, event_type, event_data) VALUES ($1, $2, $3)',
        [id, 'CONTRACT_SIGNED', JSON.stringify({ provider: 'MockSign', codeVerified: true })]
      );
      await pool.query(
        'INSERT INTO loan_request_events(loan_request_id, event_type, event_data) VALUES ($1, $2, $3)',
        [id, 'DISBURSEMENT_STARTED', JSON.stringify({ mode: 'BANK_TRANSFER' })]
      );

      await pool.query(
        `UPDATE loan_requests
            SET status = $1::loan_status
          WHERE id = $2`,
        ['ACTIVE', id]
      );

      await pool.query('COMMIT');
      return res.json({
        ok: true,
        newStatus: 'ACTIVE',
        message: 'Contrato firmado digitalmente y préstamo activado. El desembolso se encuentra en curso.'
      });
    } catch (err) {
      await pool.query('ROLLBACK');
      console.error('[POST /loan-requests/:id/contract/confirm-sign] DB_ERROR:', err);
      return res.status(500).json({ error: 'DB_ERROR' });
    }
  });

  return router;
};
