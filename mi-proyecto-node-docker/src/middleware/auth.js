const jwt = require('jsonwebtoken');
const pool = require('../../db');

const AUTH_COOKIE = 'app_auth';

function getJwtSecret() {
    return process.env.JWT_SECRET || 'dev-secret-cambiar-en-produccion';
}

function useSecureCookies() {
    return process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
}

function getAuthCookieOptions() {
    return {
        httpOnly: true,
        secure: useSecureCookies(),
        sameSite: 'lax',
        maxAge: 2 * 60 * 60 * 1000, // 2 horas
    };
}

function getClearCookieOptions() {
    return {
        httpOnly: true,
        secure: useSecureCookies(),
        sameSite: 'lax',
    };
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
    );
}

async function verifyAndFetchApplicant(token) {
    if (!token) throw new Error('NO_TOKEN');

    try {
        const payload = jwt.verify(token, getJwtSecret());
        const applicantId = Number(payload.sub);

        if (!Number.isFinite(applicantId) || applicantId <= 0 || payload.type !== 'applicant') {
            throw new Error('INVALID_PAYLOAD');
        }

        const { rows } = await pool.query(
            `SELECT id, national_id, first_name, last_name, email
             FROM applicants
             WHERE id = $1`,
            [applicantId]
        );

        if (!rows.length) {
            throw new Error('APPLICANT_NOT_FOUND');
        }

        return { applicantId, applicant: rows[0] };
    } catch (err) {
        // Diferenciamos errores de JWT vs errores de Base de Datos
        if (err.name === 'TokenExpiredError') throw new Error('TOKEN_EXPIRED');
        if (err.name === 'JsonWebTokenError') throw new Error('TOKEN_MALFORMED');
        
        // Si no es un error de JWT ni de lógica nuestra, es un error de sistema (DB)
        console.error('[Auth Service Error]:', err.message);
        throw err; 
    }
}

// Middleware para APIs (Retorna JSON)
async function requireAuth(req, res, next) {
    const token = req.cookies && req.cookies[AUTH_COOKIE];

    try {
        const authData = await verifyAndFetchApplicant(token);
        req.auth = authData;
        return next();
    } catch (err) {
        // Si es un error crítico de DB (no tiene un mensaje de los que lanzamos arriba)
        const isSystemError = !['NO_TOKEN', 'INVALID_PAYLOAD', 'APPLICANT_NOT_FOUND', 'TOKEN_EXPIRED', 'TOKEN_MALFORMED'].includes(err.message);
        
        if (isSystemError) {
            return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
        }

        return res.status(401).json({ error: 'INVALID_SESSION', detail: err.message });
    }
}

// Middleware para Páginas (Redirige al login)
async function requireAuthPage(req, res, next) {
    const token = req.cookies && req.cookies[AUTH_COOKIE];

    try {
        const authData = await verifyAndFetchApplicant(token);
        req.auth = authData;
        return next();
    } catch (err) {
        // En caso de error de sesión, limpiamos la cookie dañada/expirada y redirigimos
        res.clearCookie(AUTH_COOKIE, getClearCookieOptions());
        return res.redirect('/login');
    }
}

module.exports = {
    AUTH_COOKIE,
    getAuthCookieOptions,
    getClearCookieOptions,
    signApplicantToken,
    requireAuth,
    requireAuthPage
};