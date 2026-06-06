const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth')
const pool = require('../../db');

router.get('/', requireAuth, async (req, res) => {
  const applicantId = req.auth.applicantId

  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.loan_request_id, n.channel, n.template, n.payload,
              n.status, n.created_at, n.sent_at, n.read_at, n.installment_num
         FROM notifications n
         JOIN loan_requests lr ON lr.id = n.loan_request_id
        WHERE lr.applicant_id = $1
          AND n.status IN ('SENT','QUEUED')
        ORDER BY n.created_at DESC
        LIMIT 50`,
      [applicantId]
    );

    const unreadCount = rows.filter(n => !n.read_at).length;
    res.json({ notifications: rows, unreadCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.patch('/:id/read', requireAuth, async (req, res) => {
  const { id } = req.params
  const applicantId = req.auth.applicantId

  try {
    const owner = await pool.query(
      `SELECT n.id, lr.applicant_id
         FROM notifications n
         JOIN loan_requests lr ON lr.id = n.loan_request_id
        WHERE n.id = $1`,
      [id]
    )

    if (!owner.rows.length) {
      return res.status(404).json({ error: 'NOT_FOUND' })
    }

    if (Number(owner.rows[0].applicant_id) !== Number(applicantId)) {
      return res.status(403).json({ error: 'FORBIDDEN' })
    }

    await pool.query(
      `UPDATE notifications
          SET read_at = NOW()
        WHERE id = $1
          AND read_at IS NULL`,
      [id]
    )

    return res.json({ ok: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Error interno' })
  }
})

router.post('/read-all', requireAuth, async (req, res) => {
  const applicantId = req.auth.applicantId


  try {
    const result = await pool.query(
      `UPDATE notifications n
          SET read_at = NOW()
         FROM loan_requests lr
        WHERE n.loan_request_id = lr.id
          AND lr.applicant_id = $1
          AND n.read_at IS NULL`,
      [applicantId]
    );
    res.json({ ok: true, updated: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
