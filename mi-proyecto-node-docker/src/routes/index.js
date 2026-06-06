//import { Router } from 'express'
//const router = Router()
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const {
  AUTH_COOKIE,
  getAuthCookieOptions,
  getClearCookieOptions,
  signApplicantToken,
  requireAuth
} = require('../middleware/auth')

router.get('/', (req, res) => res.render('home', { title: 'Inicio' }))
router.get('/about', (req, res) => res.render('about', { title: 'About Us' }))

// Redirigir /simulate a la sección del simulador en la home
router.get('/simulate', (req, res) => res.redirect('/#simulate'))

// Página dedicada del simulador
router.get('/simulator', (req, res) => res.render('simulator', { title: 'Simulador de préstamos' }))

// Registro (form visual) y envío (server-rendered)
const pool = require('../../db')
async function ensureApplicants() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applicants (
      id SERIAL PRIMARY KEY,
      national_id TEXT NOT NULL UNIQUE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      date_of_birth DATE NOT NULL,
      nationality TEXT,
      address TEXT NOT NULL,
      address_proof_type TEXT,
      address_proof_ref TEXT,
      income_source TEXT,
      monthly_income NUMERIC(12,2),
      income_proof_type TEXT,
      income_proof_ref TEXT,
      financial_history_note TEXT,
      password_hash TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query('ALTER TABLE applicants ADD COLUMN IF NOT EXISTS password_hash TEXT')
}

router.get('/register', (_req, res) =>
  res.render('register', { title: 'Registro de Solicitante', flash: null, applicantId: null, nationalId: null })
)

router.post('/register', async (req, res) => {
  const b = req.body || {}
  try {
    await ensureApplicants()
    const required = ['national_id','first_name','last_name','email','date_of_birth','address','password','password_confirm']
    for (const k of required) {
      if (!b[k]) {
        return res.status(400).render('register', {
          title: 'Registro de Solicitante',
          flash: `Falta ${k}`,
          applicantId: null,
          nationalId: b.national_id || null
        })
      }
    }
    if (String(b.password).length < 6) {
      return res.status(400).render('register', {
        title: 'Registro de Solicitante',
        flash: 'La contraseña debe tener al menos 6 caracteres',
        applicantId: null,
        nationalId: b.national_id || null
      })
    }
    if (String(b.password) !== String(b.password_confirm)) {
      return res.status(400).render('register', {
        title: 'Registro de Solicitante',
        flash: 'Las contraseñas no coinciden',
        applicantId: null,
        nationalId: b.national_id || null
      })
    }

    const dob = new Date(b.date_of_birth)
    if (isNaN(dob.getTime())) {
      return res.status(400).render('register', {
        title: 'Registro de Solicitante',
        flash: 'Fecha de nacimiento inválida',
        applicantId: null,
        nationalId: b.national_id || null
      })
    }
    const age = Math.floor((Date.now() - dob.getTime()) / (365.25*24*3600*1000))
    if (age < 18) {
      return res.status(400).render('register', {
        title: 'Registro de Solicitante',
        flash: 'Debe ser mayor de 18 años',
        applicantId: null,
        nationalId: b.national_id || null
      })
    }

    const passwordHash = await bcrypt.hash(String(b.password), 10)

    const r = await pool.query(
      `INSERT INTO applicants (
        national_id, first_name, last_name, email, phone, date_of_birth, nationality,
        address, address_proof_type, address_proof_ref,
        income_source, monthly_income, income_proof_type, income_proof_ref,
        financial_history_note, password_hash
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (national_id) DO UPDATE SET national_id = EXCLUDED.national_id RETURNING id`,
      [b.national_id, b.first_name, b.last_name, b.email, b.phone || null, b.date_of_birth, b.nationality || null,
       b.address, b.address_proof_type || null, b.address_proof_ref || null,
       b.income_source || null, b.monthly_income || null, b.income_proof_type || null, b.income_proof_ref || null,
       b.financial_history_note || null, passwordHash]
    )
    const applicantId = (r.rows && r.rows[0] && r.rows[0].id) || null
    res.render('register', {
      title: 'Registro de Solicitante',
      flash: 'Registro completado. Ahora puedes simular y solicitar.',
      applicantId,
      nationalId: b.national_id || null
    })
  } catch (err) {
    console.error(err)
    res.status(500).render('register', {
      title: 'Registro de Solicitante',
      flash: 'Error en el servidor',
      applicantId: null,
      nationalId: b.national_id || null
    })
  }
})

// Login (Mi Cuenta)
router.get('/login', (_req, res) =>
  res.render('login', { title: 'Ingresar', flash: null, welcome: null, applicantId: null, nationalId: null })
)

router.post('/login', async (req, res) => {
  const b = req.body || {}
  const rut = (b.national_id || '').trim()
  const password = b.password || ''
  if (!rut || !password) {
    return res.status(400).render('login', {
      title: 'Ingresar',
      flash: 'Debes ingresar RUT y contraseña.',
      welcome: null,
      applicantId: null,
      nationalId: null
    })
  }
  try {
    await ensureApplicants()
    const q = await pool.query(
      'SELECT id, first_name, password_hash, national_id FROM applicants WHERE national_id = $1',
      [rut]
    )
    if (!q.rows.length || !q.rows[0].password_hash) {
      return res.status(401).render('login', {
        title: 'Ingresar',
        flash: 'Credenciales inválidas.',
        welcome: null,
        applicantId: null,
        nationalId: null
      })
    }
    const row = q.rows[0]
    const ok = await bcrypt.compare(String(password), row.password_hash)
    if (!ok) {
      return res.status(401).render('login', {
        title: 'Ingresar',
        flash: 'Credenciales inválidas.',
        welcome: null,
        applicantId: null,
        nationalId: null
      })
    }
   const token = signApplicantToken(row)
   res.cookie(AUTH_COOKIE, token, getAuthCookieOptions())
   return res.redirect('/my-loans')
  }
  catch (err) {
    console.error(err)
    return res.status(500).render('login', {
      title: 'Ingresar',
      flash: 'Error en el servidor.',
      welcome: null,
      applicantId: null,
      nationalId: null
    })
  }
})
router.post('/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE, getClearCookieOptions())
  return res.redirect('/login')
})

router.get('/api/auth/me', requireAuth, (req, res) => {
  return res.json({
    id: req.auth.applicant.id,
    national_id: req.auth.applicant.national_id,
    first_name: req.auth.applicant.first_name,
    last_name: req.auth.applicant.last_name,
    email: req.auth.applicant.email
  })
})
module.exports = router
