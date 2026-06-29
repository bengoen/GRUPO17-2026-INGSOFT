const express = require('express')
const router = express.Router()
const pool = require('../../db')
const http = require('http')
const { requireAuth } = require('../middleware/auth')

const SCORING_URL = process.env.CREDIT_SCORING_URL || 'http://credit_scoring:5001'

// ============================================================
// MAPAS ORDINALES
// ============================================================
const ORDINAL_MAPS = {
  education: {
    'Lower secondary': 0, 'Secondary / secondary special': 1,
    'Incomplete higher': 2, 'Higher education': 3, 'Academic degree': 4,
    'Secundaria incompleta': 0, 'Secundaria completa': 1,
    'Superior incompleta': 2, 'Superior completa': 3, 'Postgrado': 4
  },
  family_status: {
    'Married': 0, 'Civil marriage': 0, 'Single / not married': 1,
    'Separated': 2, 'Widow': 2,
    'Casado/a': 0, 'Soltero/a': 1, 'Separado/a': 2, 'Viudo/a': 2
  },
  housing: {
    'House / apartment': 0, 'With parents': 1, 'Municipal apartment': 2,
    'Rented apartment': 3, 'Office apartment': 2, 'Co-op apartment': 2,
    'Propia': 0, 'Con padres': 1, 'Municipal': 2, 'Arrendada': 3
  },
  income_type: {
    'Working': 0, 'Commercial associate': 1, 'Pensioner': 2,
    'State servant': 3, 'Student': 4, 'Unemployed': 5,
    'Empleado': 0, 'Independiente': 1, 'Pensionado': 2, 'Servidor público': 3
  }
}

// ============================================================
// FUNCIONES DE APOYO (Lógica de Negocio)
// ============================================================
function applyHardFilters(applicant, formData) {
  const errors = []
  if (applicant.date_of_birth) {
    const age = (Date.now() - new Date(applicant.date_of_birth).getTime()) / (365.25 * 24 * 3600 * 1000)
    if (age < 18) errors.push('Debe ser mayor de 18 años')
    if (age > 75) errors.push('Edad máxima permitida: 75 años')
  } else {
    errors.push('Fecha de nacimiento requerida')
  }
  const income = Number(applicant.monthly_income || formData.monthly_income || 0)
  if (income < 200000) errors.push('Ingreso mensual mínimo requerido: $200.000 CLP')
  const credit = Number(formData.amt_credit || 0)
  if (credit <= 0) errors.push('Monto de crédito debe ser mayor a 0')
  if (credit > income * 20) errors.push(`Monto máximo permitido: ${(income * 20).toLocaleString('es-CL')} CLP (20x ingreso)`)
  const yearsEmployed = Number(formData.years_employed || 0)
  if (yearsEmployed < 0.25) errors.push('Antigüedad laboral mínima: 3 meses')
  return errors
}

function validateFinancialBurden(income, existingDebt, newPayment) {
  if (income <= 0) return { valid: false, ratio: 1, maxPayment: 0 }
  const totalBurden = (existingDebt + newPayment) / income
  const maxPayment = Math.max(0, income * 0.4 - existingDebt)
  return {
    valid: totalBurden <= 0.40,
    ratio: Math.round(totalBurden * 10000) / 10000,
    ratioPercent: Math.round(totalBurden * 1000) / 10,
    maxPayment: Math.round(maxPayment),
    existingDebt, newPayment, income
  }
}

async function updateApplicantScoringInDB(applicantId, data, formData) {
  const query = `
    UPDATE applicants SET
      credit_score = $2, risk_category = $3, assigned_rate = $4,
      probability_of_default = $5, scoring_approved = $6, scored_at = NOW(),
      years_employed = $7, cnt_children = $8, cnt_fam_members = $9,
      own_car = $10, own_realty = $11, education_type = $12,
      family_status = $13, housing_type = $14, total_existing_debt = $15
    WHERE id = $1`
  
  const values = [
    applicantId,
    data.score || 0, data.risk_category || 'REJECTED', data.annual_rate || null,
    data.probability_of_default || null, data.approved || false,
    formData.years_employed || null, formData.cnt_children || 0,
    formData.cnt_fam_members || 1, formData.own_car || false,
    formData.own_realty || false, formData.education_type || null,
    formData.family_status || null, formData.housing_type || null,
    formData.total_existing_debt || 0
  ]
  return pool.query(query, values)
}

function callScoringService(features) {
  return new Promise((resolve, reject) => {
    const url = new URL('/predict', SCORING_URL)
    const body = JSON.stringify(features)
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error('Respuesta inválida del servidor de Scoring (IA)')) }
      })
    })
    req.on('error', (err) => reject(new Error(`No se pudo conectar con el servicio de IA: ${err.message}`)))
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Tiempo de espera agotado con el servicio de IA')) })
    req.write(body)
    req.end()
  })
}

function buildFeatures(applicant, formData) {
  const age = applicant.date_of_birth
    ? (Date.now() - new Date(applicant.date_of_birth).getTime()) / (365.25 * 24 * 3600 * 1000)
    : null
  const income = Number(applicant.monthly_income || formData.monthly_income || 0)
  const credit = Number(formData.amt_credit || 0)
  const annuity = Number(formData.amt_annuity || 0)
  const goodsPrice = Number(formData.amt_goods_price || credit)
  const yearsEmployed = Number(formData.years_employed || 0)
  const children = Number(formData.cnt_children || 0)
  const familyMembers = Number(formData.cnt_fam_members || 1)
  const eduCode = ORDINAL_MAPS.education[formData.education_type] ?? -1
  const famCode = ORDINAL_MAPS.family_status[formData.family_status] ?? -1
  const housCode = ORDINAL_MAPS.housing[formData.housing_type] ?? -1
  const incCode = ORDINAL_MAPS.income_type[formData.income_type] ?? -1
  const ownCar = (formData.own_car === true || formData.own_car === 'true') ? 1 : 0
  const ownRealty = (formData.own_realty === true || formData.own_realty === 'true') ? 1 : 0
  const ext = (formData.ext_source !== undefined && formData.ext_source !== '') ? Number(formData.ext_source) : null
  const hasExt = ext !== null

  return {
    AMT_INCOME_TOTAL: income, AMT_CREDIT: credit, AMT_ANNUITY: annuity,
    AMT_GOODS_PRICE: goodsPrice, AGE_YEARS: age, YEARS_EMPLOYED: yearsEmployed,
    CNT_CHILDREN: children, CNT_FAM_MEMBERS: familyMembers,
    FLAG_OWN_CAR: ownCar, FLAG_OWN_REALTY: ownRealty,
    CREDIT_INCOME_RATIO: credit / (income + 1),
    ANNUITY_INCOME_RATIO: annuity / (income + 1),
    CREDIT_ANNUITY_RATIO: credit / (annuity + 1),
    ANNUITY_CREDIT_RATIO: annuity / (credit + 1),
    GOODS_CREDIT_DIFF: credit - goodsPrice,
    GOODS_INCOME_RATIO: goodsPrice / (income + 1),
    PAYMENT_RATE: annuity / (credit + 1),
    INCOME_CREDIT_DIFF: income - annuity,
    INCOME_PER_PERSON: income / (familyMembers + 1),
    CREDIT_PER_PERSON: credit / (familyMembers + 1),
    CHILDREN_RATIO: children / (familyMembers + 0.1),
    AGE_EMPLOYED_RATIO: yearsEmployed / ((age || 1) + 1),
    EDUCATION_CODE: eduCode, FAMILY_STATUS_CODE: famCode,
    HOUSING_CODE: housCode, INCOME_CODE: incCode,
    EXT_SOURCE_1: ext, EXT_SOURCE_2: ext, EXT_SOURCE_3: ext,
    EXT1_NULL: hasExt ? 0 : 1, EXT2_NULL: hasExt ? 0 : 1, EXT3_NULL: hasExt ? 0 : 1,
    EXT_NULL_COUNT: hasExt ? 0 : 3, EXT_MEAN: ext, EXT_STD: hasExt ? 0 : null,
    EXT_MIN: ext, EXT_MAX: ext, EXT_2_x_3: hasExt ? ext * ext : null,
    EXT_1_x_2: hasExt ? ext * ext : null, EXT_1_x_3: hasExt ? ext * ext : null,
    EXT_1_x_2_x_3: hasExt ? ext * ext * ext : null,
    EXT_2_SQ: hasExt ? ext * ext : null, EXT_3_SQ: hasExt ? ext * ext : null,
    EXT_1_SQ: hasExt ? ext * ext : null, EXT_2_CB: hasExt ? ext * ext * ext : null,
    EXT_3_CB: hasExt ? ext * ext * ext : null,
    EXT_2_x_AGE: hasExt ? ext * (age || 30) : null,
    EXT_3_x_AGE: hasExt ? ext * (age || 30) : null,
    EXT_2_x_INCOME: hasExt ? ext * income : null,
    EXT_3_x_CREDIT: hasExt ? ext * credit : null,
    EXT_MEAN_x_AGE: hasExt ? ext * (age || 30) : null,
    EXT_RANGE: hasExt ? 0 : null, FLAG_EMPLOY_ANOMALY: 0
  }
}

// ============================================================
// RUTAS
// ============================================================

router.post('/evaluate', requireAuth, async (req, res) => {
  const applicantId = req.auth.applicantId
  const formData = req.body

  try {
    const { rows } = await pool.query('SELECT * FROM applicants WHERE id = $1', [applicantId])
    if (!rows.length) return res.status(404).json({ error: 'APPLICANT_NOT_FOUND' })
    const applicant = rows[0]

    // 1. Filtros duros
    const hardFilterErrors = applyHardFilters(applicant, formData)
    if (hardFilterErrors.length > 0) {
      await updateApplicantScoringInDB(applicantId, { risk_category: 'REJECTED', approved: false }, formData)
      return res.json({ success: true, data: { applicant_id: applicantId, rejected_by_filters: true, filter_errors: hardFilterErrors, approved: false } })
    }

    // 2. Carga financiera
    const burden = validateFinancialBurden(Number(applicant.monthly_income || formData.monthly_income || 0), Number(formData.total_existing_debt || 0), Number(formData.amt_annuity || 0))
    if (!burden.valid) {
      await updateApplicantScoringInDB(applicantId, { risk_category: 'REJECTED', approved: false }, formData)
      return res.json({ success: true, data: { applicant_id: applicantId, rejected_by_filters: true, filter_errors: [`Carga financiera excede el 40% del ingreso (${burden.ratioPercent}%).`], approved: false } })
    }

    // 3. Modelo IA
    const features = buildFeatures(applicant, formData)
    const modelResult = await callScoringService(features)

    if (!modelResult.success) {
      return res.status(502).json({ error: 'ERROR_MODELO_IA', detail: modelResult.error })
    }

    // 4. Guardar y responder
    await updateApplicantScoringInDB(applicantId, modelResult, formData)

    res.json({
      success: true,
      data: {
        applicant_id: applicantId,
        score: modelResult.score,
        risk_category: modelResult.risk_category,
        annual_rate: modelResult.annual_rate,
        approved: modelResult.approved,
        financial_burden: burden
      }
    })

  } catch (err) {
    console.error('[SCORING ERROR]:', err)
    res.status(500).json({ error: 'INTERNAL_ERROR', detail: err.message })
  }
})

router.post('/validate-burden', async (req, res) => {
  try {
    const { monthly_income, total_existing_debt, new_monthly_payment } = req.body || {}
    const income = Number(monthly_income || 0)
    if (income <= 0) return res.status(400).json({ error: 'INVALID_INCOME' })
    const burden = validateFinancialBurden(income, Number(total_existing_debt || 0), Number(new_monthly_payment || 0))
    res.json({ success: true, data: burden })
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR' })
  }
})

router.get('/profile/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, credit_score, risk_category, assigned_rate, probability_of_default, scoring_approved, scored_at FROM applicants WHERE id = $1', [req.auth.applicantId])
    if (!rows.length) return res.status(404).json({ error: 'NOT_FOUND' })
    res.json({ success: true, data: rows[0] })
  } catch (err) {
    res.status(500).json({ error: 'DB_ERROR' })
  }
})

module.exports = router