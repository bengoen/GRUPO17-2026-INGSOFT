async function assertLoanOwner(pool, loanId, applicantId) {
  const id = Number(loanId)
  const authApplicantId = Number(applicantId)

  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, status: 400, error: 'BAD_REQUEST' }
  }

  const { rows } = await pool.query(
    `SELECT id, applicant_id
       FROM loan_requests
      WHERE id = $1`,
    [id]
  )

  if (!rows.length) {
    return { ok: false, status: 404, error: 'NOT_FOUND' }
  }

  if (Number(rows[0].applicant_id) !== authApplicantId) {
    return { ok: false, status: 403, error: 'FORBIDDEN' }
  }

  return { ok: true, loan: rows[0] }
}

module.exports = {
  assertLoanOwner
}