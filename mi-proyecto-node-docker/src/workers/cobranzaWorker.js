const { buildInstallmentSchedule } = require('../utils/installments');

module.exports = function startCobranzaWorker(pool, logger = console) {
  
  /**
    Procesa un único préstamo para determinar si requiere notificaciones.
    Se separa para que un error en un préstamo no afecte a los demás.
  **/
  async function processLoan(loan) {
    try {
      const schedule = buildInstallmentSchedule(loan);

      // 1. Obtener cuotas ya pagadas o autorizadas
      let paidInstallments = new Set();
      const { rows: paid } = await pool.query(
        `SELECT installment FROM loan_installment_payments
          WHERE loan_request_id = $1 AND status IN ('AUTHORIZED','PAID')`,
        [loan.id]
      );
      paidInstallments = new Set(paid.map(r => r.installment));

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // 2. Revisar el calendario de cuotas
      for (const row of schedule) {
        // Si la cuota ya está pagada, la saltamos
        if (paidInstallments.has(row.installment)) continue;

        const due = new Date(row.dueDate);
        due.setHours(0, 0, 0, 0);
        
        // Calculamos diferencia de días
        const diffTime = due.getTime() - today.getTime();
        const daysUntilDue = Math.round(diffTime / (1000 * 60 * 60 * 24));

        let template = null;
        if (daysUntilDue === 3) template = 'installment_due_soon';
        else if (daysUntilDue === 0) template = 'installment_due_today';
        else if (daysUntilDue < 0 && daysUntilDue >= -30) template = 'installment_overdue';

        if (!template) continue;

        // 3. Insertar notificación (El ON CONFLICT evita duplicados el mismo día)
        await pool.query(
          `INSERT INTO notifications
             (loan_request_id, channel, template, payload, status, installment_num, notification_date)
           VALUES ($1, 'EMAIL', $2,
             jsonb_build_object(
               'installment',  $3::int,
               'dueDate',      $4::text,
               'totalPayment', $5::numeric,
               'daysUntilDue', $6::int,
               'loanId',       $1::int
             ),
             'QUEUED', $3, CURRENT_DATE)
           ON CONFLICT (loan_request_id, installment_num, notification_date)
           DO NOTHING`,
          [loan.id, template, row.installment, row.dueDate, Math.round(row.totalPayment), daysUntilDue]
        );
      }
    } catch (loanErr) {
      // Si falla un préstamo (ej: datos corruptos), lo logueamos y seguimos con el siguiente
      logger.error(`[COBRANZA] Error procesando préstamo ID ${loan.id}:`, loanErr.message);
    }
  }

  async function tick() {
    logger.log('[COBRANZA] Ejecutando ciclo de revisión...');
    try {
      // Obtenemos solo préstamos activos
      const { rows: loans } = await pool.query(
        `SELECT id, amount, term_months, monthly_rate, monthly_payment, status, created_at
           FROM loan_requests
          WHERE status IN ('ACTIVE', 'DISBURSED')`
      );

      // Procesamos cada préstamo de forma secuencial pero protegida
      for (const loan of loans) {
        await processLoan(loan);
      }
      
      logger.log(`[COBRANZA] Ciclo completado. Préstamos revisados: ${loans.length}`);
    } catch (err) {
      logger.error('[COBRANZA] Error crítico en el ciclo principal:', err.message);
    }
  }

  // Ejecutar cada 60 segundos (ajustable según necesidad)
  const handle = setInterval(tick, 60000);
  
  logger.log('[COBRANZA] Worker iniciado exitosamente');
  
  // Retornar función de limpieza para detener el worker si es necesario
  return () => {
    logger.log('[COBRANZA] Deteniendo worker...');
    clearInterval(handle);
  };
};