const express = require('express')
const router = express.Router()
const pool = require('../../db')
const http = require('http')

const SCORING_URL = process.env.CREDIT_SCORING_URL || 'http://credit_scoring:5001'

// ============================================================
// MAPAS ORDINALES (mismos del notebook)
// ============================================================
const ORDINAL_MAPS = {
  education: {
    'Lower secondary': 0, 'Secondary / secondary special': 1,
    'Incomplete higher': 2, 'Higher education': 3, 'Academic degree': 4,
    // español
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
// FILTROS DUROS (reglas de negocio — rechazan ANTES del modelo)
// ============================================================
function applyHardFilters(applicant, formData) {
  const errors = []

  // 1. Edad: 18-75 años
  if (applicant.date_of_birth) {
    const age = (Date.now() - new Date(applicant.date_of_birth).getTime()) / (365.25 * 24 * 3600 * 1000)
    if (age < 18) errors.push('Debe ser mayor de 18 años')
    if (age > 75) errors.push('Edad máxima permitida: 75 años')
  } else {
    errors.push('Fecha de nacimiento requerida')
  }

  // 2. Ingreso mensual mínimo: $200.000 CLP
  const income = Number(applicant.monthly_income || formData.monthly_income || 0)
  if (income < 200000) errors.push('Ingreso mensual mínimo requerido: $200.000 CLP')

  // 3. Monto de crédito solicitado > 0
  const credit = Number(formData.amt_credit || 0)
  if (credit <= 0) errors.push('Monto de crédito debe ser mayor a 0')

  // 4. Monto máximo: 20x ingreso mensual
  if (credit > income * 20) errors.push(`Monto máximo permitido: ${(income * 20).toLocaleString('es-CL')} CLP (20x ingreso)`)

  // 5. Antigüedad laboral mínima: 3 meses (0.25 años)
  const yearsEmployed = Number(formData.years_employed || 0)
  if (yearsEmployed < 0.25) errors.push('Antigüedad laboral mínima: 3 meses')

  return errors
}

// ============================================================
// VALIDACIÓN DE CARGA FINANCIERA
// ============================================================
function validateFinancialBurden(income, existingDebt, newPayment) {
  if (income <= 0) return { valid: false, ratio: 1, maxPayment: 0 }
  const totalBurden = (existingDebt + newPayment) / income
  const maxPayment = Math.max(0, income * 0.4 - existingDebt)
  return {
    valid: totalBurden <= 0.40,
    ratio: Math.round(totalBurden * 10000) / 10000,
    ratioPercent: Math.round(totalBurden * 1000) / 10,
    maxPayment: Math.round(maxPayment),
    existingDebt,
    newPayment,
    income
  }
}

// ============================================================
// LLAMADA AL MICROSERVICIO PYTHON
// ============================================================
function callScoringService(features) {
  return new Promise((resolve, reject) => {
    const url = new URL('/predict', SCORING_URL)
    const body = JSON.stringify(features)

    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error('Invalid JSON from scoring service')) }
      })
    })

    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Scoring service timeout')) })
    req.write(body)
    req.end()
  })
}

// ============================================================
// CONSTRUIR VECTOR DE FEATURES
// ============================================================
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

  // Codificaciones ordinales
  const eduCode = ORDINAL_MAPS.education[formData.education_type] != null
    ? ORDINAL_MAPS.education[formData.education_type] : -1
  const famCode = ORDINAL_MAPS.family_status[formData.family_status] != null
    ? ORDINAL_MAPS.family_status[formData.family_status] : -1
  const housCode = ORDINAL_MAPS.housing[formData.housing_type] != null
    ? ORDINAL_MAPS.housing[formData.housing_type] : -1
  const incCode = ORDINAL_MAPS.income_type[formData.income_type] != null
    ? ORDINAL_MAPS.income_type[formData.income_type] : -1

  const ownCar = formData.own_car === true || formData.own_car === 'true' ? 1 : 0
  const ownRealty = formData.own_realty === true || formData.own_realty === 'true' ? 1 : 0

  return {
    AMT_INCOME_TOTAL: income,
    AMT_CREDIT: credit,
    AMT_ANNUITY: annuity,
    AMT_GOODS_PRICE: goodsPrice,
    AGE_YEARS: age,
    YEARS_EMPLOYED: yearsEmployed,
    CNT_CHILDREN: children,
    CNT_FAM_MEMBERS: familyMembers,
    FLAG_OWN_CAR: ownCar,
    FLAG_OWN_REALTY: ownRealty,

    // Ratios financieros (mismas fórmulas del notebook)
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
    ID_AGE_RATIO: null,
    YEARS_ID_PUBLISH: null,
    YEARS_REGISTRATION: null,
    YEARS_LAST_PHONE: null,

    // Codificaciones ordinales
    EDUCATION_CODE: eduCode,
    FAMILY_STATUS_CODE: famCode,
    HOUSING_CODE: housCode,
    INCOME_CODE: incCode,

    // EXT_SOURCE (en producción vendrían de bureau de crédito — sin OCR quedan null)
    EXT_SOURCE_1: null,
    EXT_SOURCE_2: null,
    EXT_SOURCE_3: null,
    EXT1_NULL: 1,
    EXT2_NULL: 1,
    EXT3_NULL: 1,
    EXT_NULL_COUNT: 3,
    EXT_MEAN: null,
    EXT_STD: null,
    EXT_MIN: null,
    EXT_MAX: null,
    EXT_2_x_3: null,
    EXT_1_x_2: null,
    EXT_1_x_3: null,
    EXT_1_x_2_x_3: null,
    EXT_2_SQ: null,
    EXT_3_SQ: null,
    EXT_1_SQ: null,
    EXT_2_CB: null,
    EXT_3_CB: null,
    EXT_2_x_AGE: null,
    EXT_3_x_AGE: null,
    EXT_2_x_INCOME: null,
    EXT_3_x_CREDIT: null,
    EXT_MEAN_x_AGE: null,
    EXT_RANGE: null,

    FLAG_EMPLOY_ANOMALY: 0
  }
}

// ============================================================
// POST /api/scoring/evaluate
// Flujo completo: filtros duros → modelo → guardar en DB
// ============================================================
router.post('/evaluate', async (req, res) => {
  const { applicant_id } = req.body || {}
  if (!applicant_id) return res.status(400).json({ error: 'MISSING_APPLICANT_ID' })

  const applicantId = Number(applicant_id)
  if (!Number.isFinite(applicantId)) return res.status(400).json({ error: 'BAD_ID' })

  try {
    // 1. Obtener datos del solicitante
    const { rows } = await pool.query('SELECT * FROM applicants WHERE id = $1', [applicantId])
    if (!rows.length) return res.status(404).json({ error: 'APPLICANT_NOT_FOUND' })
    const applicant = rows[0]
    const formData = req.body

    // 2. Filtros duros
    const hardFilterErrors = applyHardFilters(applicant, formData)
    if (hardFilterErrors.length > 0) {
      // Guardar rechazo por filtros duros
      await pool.query(
        `UPDATE applicants SET credit_score = 0, risk_category = 'REJECTED',
         assigned_rate = NULL, scoring_approved = FALSE, scored_at = NOW()
         WHERE id = $1`, [applicantId]
      )
      return res.json({
        success: true,
        data: {
          applicant_id: applicantId,
          rejected_by_filters: true,
          filter_errors: hardFilterErrors,
          score: 0,
          risk_category: 'REJECTED',
          approved: false
        }
      })
    }

    // 3. Validación de carga financiera
    const income = Number(applicant.monthly_income || formData.monthly_income || 0)
    const existingDebt = Number(formData.total_existing_debt || 0)
    const newPayment = Number(formData.amt_annuity || 0)
    const burden = validateFinancialBurden(income, existingDebt, newPayment)

    if (!burden.valid) {
      await pool.query(
        `UPDATE applicants SET credit_score = 0, risk_category = 'REJECTED',
         assigned_rate = NULL, scoring_approved = FALSE, scored_at = NOW()
         WHERE id = $1`, [applicantId]
      )
      return res.json({
        success: true,
        data: {
          applicant_id: applicantId,
          rejected_by_filters: true,
          filter_errors: [`Carga financiera excede el 40% del ingreso (actual: ${burden.ratioPercent}%). Cuota máxima permitida: $${burden.maxPayment.toLocaleString('es-CL')} CLP`],
          financial_burden: burden,
          score: 0,
          risk_category: 'REJECTED',
          approved: false
        }
      })
    }

    // 4. Construir features y llamar al modelo
    const features = buildFeatures(applicant, formData)
    const modelResult = await callScoringService(features)

    if (!modelResult.success) {
      return res.status(500).json({ error: 'SCORING_ERROR', detail: modelResult.error })
    }

    // 5. Guardar resultado en DB
    await pool.query(
      `UPDATE applicants SET
         credit_score = $2, risk_category = $3, assigned_rate = $4,
         probability_of_default = $5, scoring_approved = $6, scored_at = NOW(),
         years_employed = $7, cnt_children = $8, cnt_fam_members = $9,
         own_car = $10, own_realty = $11, education_type = $12,
         family_status = $13, housing_type = $14, total_existing_debt = $15
       WHERE id = $1`,
      [
        applicantId,
        modelResult.score, modelResult.risk_category, modelResult.annual_rate,
        modelResult.probability_of_default, modelResult.approved,
        formData.years_employed || null, formData.cnt_children || 0,
        formData.cnt_fam_members || 1, formData.own_car || false,
        formData.own_realty || false, formData.education_type || null,
        formData.family_status || null, formData.housing_type || null,
        formData.total_existing_debt || 0
      ]
    )

    // 6. Responder
    res.json({
      success: true,
      data: {
        applicant_id: applicantId,
        rejected_by_filters: false,
        score: modelResult.score,
        probability_of_default: modelResult.probability_of_default,
        risk_category: modelResult.risk_category,
        annual_rate: modelResult.annual_rate,
        approved: modelResult.approved,
        financial_burden: burden
      }
    })

  } catch (err) {
    console.error('[SCORING] Error:', err.message)
    res.status(500).json({ error: 'SCORING_UNAVAILABLE', detail: err.message })
  }
})

// ============================================================
// POST /api/scoring/validate-burden
// Validación rápida de carga financiera (sin llamar al modelo)
// ============================================================
router.post('/validate-burden', async (req, res) => {
  const { monthly_income, total_existing_debt, new_monthly_payment } = req.body || {}

  const income = Number(monthly_income || 0)
  const existingDebt = Number(total_existing_debt || 0)
  const newPayment = Number(new_monthly_payment || 0)

  if (income <= 0) return res.status(400).json({ error: 'INVALID_INCOME' })

  const burden = validateFinancialBurden(income, existingDebt, newPayment)
  res.json({ success: true, data: burden })
})

// ============================================================
// GET /api/scoring/profile/:applicantId
// Obtener score guardado del perfil
// ============================================================
router.get('/profile/:applicantId', async (req, res) => {
  const id = Number(req.params.applicantId)
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'BAD_ID' })

  try {
    const { rows } = await pool.query(
      `SELECT id, credit_score, risk_category, assigned_rate,
              probability_of_default, scoring_approved, scored_at
       FROM applicants WHERE id = $1`, [id]
    )
    if (!rows.length) return res.status(404).json({ error: 'NOT_FOUND' })

    const a = rows[0]
    res.json({
      success: true,
      data: {
        applicant_id: a.id,
        score: a.credit_score,
        risk_category: a.risk_category,
        annual_rate: a.assigned_rate ? Number(a.assigned_rate) : null,
        probability_of_default: a.probability_of_default ? Number(a.probability_of_default) : null,
        approved: a.scoring_approved,
        scored_at: a.scored_at
      }
    })
  } catch (err) {
    console.error('[SCORING] Profile error:', err.message)
    res.status(500).json({ error: 'DB_ERROR' })
  }
})

module.exports = router
