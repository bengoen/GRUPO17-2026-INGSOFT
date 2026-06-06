const jwt = require('jsonwebtoken')
const pool = require('../../db')

const AUTH_COOKIE = 'app_auth'

function getJwtSecret() {
    return process.env.JWT_SECRET || 'dev-secret-cambiar-en-produccion'

}

function useSecureCookies() {
    return process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production'
}

function getAuthCookieOptions() {
    return {
        httpOnly: true,
        secure: useSecureCookies(),
        sameSite: 'lax',
        maxAge: 2*60*60*1000, // 2 horas
    }
}

function getClearCookieOptions() {
    return {
        httpOnly: true,
        secure: useSecureCookies(),
        sameSite: 'lax',
    }
}   

function signApplicantToken(applicant) {
    return jwt.sign(
        {
            sub: String(applicant.id),
            type: 'applicant',
        },
        getJwtSecret(),
        {
            expiresIn: process.env.JWT_EXPIRES_IN || '2h',
        }
    )
}

async function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[AUTH_COOKIE]

  if (!token) {
    return res.status(401).json({ error: 'AUTH_REQUIRED' })
  }

  try {
    const payload = jwt.verify(token, getJwtSecret())
    const applicantId = Number(payload.sub)

    if (!Number.isFinite(applicantId) || applicantId <= 0 || payload.type !== 'applicant') {
      return res.status(401).json({ error: 'INVALID_SESSION' })
    }

    const { rows } = await pool.query(
      `SELECT id, national_id, first_name, last_name, email
         FROM applicants
        WHERE id = $1`,
      [applicantId]
    )

    if (!rows.length) {
      return res.status(401).json({ error: 'INVALID_SESSION' })
    }

    req.auth = {
      applicantId,
      applicant: rows[0]
    }

    return next()
  } catch (err) {
    return res.status(401).json({ error: 'INVALID_SESSION' })
  }
}

async function requireAuthPage(req, res, next) {
  const token = req.cookies && req.cookies[AUTH_COOKIE]

  if (!token) {
    return res.redirect('/login')
  }

  try {
    const payload = jwt.verify(token, getJwtSecret())
    const applicantId = Number(payload.sub)

    if (!Number.isFinite(applicantId) || applicantId <= 0 || payload.type !== 'applicant') {
      return res.redirect('/login')
    }

    const { rows } = await pool.query(
      `SELECT id, national_id, first_name, last_name, email
         FROM applicants
        WHERE id = $1`,
      [applicantId]
    )

    if (!rows.length) {
      return res.redirect('/login')
    }

    req.auth = {
      applicantId,
      applicant: rows[0]
    }

    return next()
  } catch (err) {
    return res.redirect('/login')
  }
}

module.exports = {
  AUTH_COOKIE,
  getAuthCookieOptions,
  getClearCookieOptions,
  signApplicantToken,
  requireAuth,
  requireAuthPage
}
