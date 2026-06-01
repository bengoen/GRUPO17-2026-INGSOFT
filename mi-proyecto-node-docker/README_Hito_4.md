# README HITO 4 - Evaluación de Arquitectura

**Proyecto analizado:** Tu Préstamo Digital, sistema web de gestión de préstamos de consumo.
**Stack observado:** Node.js/Express, EJS con React embebido, PostgreSQL, workers Node para notificaciones/cobranza, servicio de scoring y SDK Transbank Webpay Plus.

## 1. Concerns principales del cliente

**Concern 1: Seguridad, identidad y control de acceso robusto.**
El cliente necesita cerrar brechas de identidad, privacidad y control de acceso. El diseño actual registra usuarios y hashea passwords, pero la aplicación guarda applicantId/nationalId en localStorage y varios endpoints reciben applicantId desde query/body. Esto permite trazabilidad funcional mínima, pero no una identidad confiable de servidor.
* **Atributos impactados:** seguridad, privacidad, integridad, auditabilidad.
* **Cambios necesarios:** implementar sesión server-side con cookie httpOnly/Secure/SameSite o JWT firmado con cookie segura; agregar middleware requireAuth; derivar applicantId desde la sesión/token y no desde el cliente; proteger loan-requests, payments, notifications, scoring y contract; agregar autorización por propietario y roles internos; remover dependencia funcional de localStorage; agregar CSRF si se usan cookies.

**Concern 2: Fiabilidad y trazabilidad de pagos, cuotas y eventos.**
El cliente requiere trazabilidad completa de estados/eventos y capacidades post-desembolso. El sistema ya tiene loan_status, loan_request_events, loan_installment_payments y workers que generan notificaciones. Sin embargo, las cuotas se calculan dinámicamente, no hay mora persistida, y los workers hacen polling a la base de datos, lo que limita garantías de entrega, reintentos e idempotencia.
* **Atributos impactados:** confiabilidad, consistencia, observabilidad, recuperabilidad.
* **Cambios necesarios:** persistir un ledger de cuotas con vencimiento, monto, estado, mora, paid_at y eventos asociados; registrar PAYMENT_INITIATED, PAYMENT_AUTHORIZED, PAYMENT_FAILED y OVERDUE_CALCULATED; hacer commit de pagos con transacciones e idempotencia por token/buy_order; usar una cola real u outbox robusto con locking, retry y dead-letter en vez de polling simple; agregar conciliación contra Transbank.

**Concern 3: Evolución hacia integraciones reales de firma y pagos.**
El cliente necesita pasar de prototipo académico a integraciones reales. Actualmente la firma digital es simulada y Webpay opera por defecto en integración, aunque el código permite configurar producción con variables de entorno. Esto resuelve demostración, pero no certificación, evidencia legal ni operación productiva.
* **Atributos impactados:** modificabilidad, interoperabilidad, disponibilidad, seguridad, testeabilidad.
* **Cambios necesarios:** introducir adapters PaymentProvider y SignatureProvider; separar mocks de proveedores reales mediante configuración; mover credenciales a secretos y no a docker-compose; almacenar provider_transaction_id, contract_hash, signed_at, evidence_url y resultado de validación; agregar callbacks/webhooks; definir checklist de paso a producción para Transbank, firma digital, logs, monitoreo y manejo de errores.

## 2. Análisis del diseño actual

El diseño actual aborda parcialmente el flujo principal: registro, simulación, creación de solicitud, cambio de estados, firma simulada, visualización de préstamos activos, pagos con Webpay y notificaciones. También hay pruebas del Hito 3 que validan reglas críticas: rechazo de menores de edad y rechazo de solicitud sin applicantId.

La brecha principal es que applicantId funciona como identificador funcional, no como autenticación robusta. Por lo tanto, la arquitectura debe mover la identidad al backend. Con Express/EJS, la opción más directa es express-session con almacenamiento en PostgreSQL; si se separa una SPA futura, JWT firmado con refresh seguro sería razonable.

Para pagos y eventos, la base ya contiene una semilla correcta de trazabilidad, pero falta convertirla en fuente de verdad financiera. El cuadro de cuotas debería persistirse al activar/desembolsar el préstamo, no recalcularse siempre desde la fecha de creación. La mora debe calcularse y registrarse como evento y como dato de cuota.

Para integraciones, conviene aislar Transbank y firma digital detrás de interfaces internas. Así las pruebas usan mocks controlados, integración usa sandbox y producción cambia solo configuración/adapters, no la lógica del dominio.

## 3. Trade-offs y riesgos

**Trade-off 1: EJS con React embebido vs SPA separada.**
* **Ventaja actual:** menor complejidad inicial, menos tooling y entrega rápida para el hito.
* **Riesgo:** estado duplicado en navegador, dependencia de localStorage, guards de ruta débiles y menor testeabilidad de flujos complejos.

**Trade-off 2: Worker interno con polling a PostgreSQL vs cola/servicio independiente.**
* **Ventaja actual:** simple de desplegar con Docker Compose y suficiente para demostración.
* **Riesgo:** latencia fija, duplicación si hay múltiples instancias, reintentos poco controlados y falta de dead-letter ante errores repetidos.

**Trade-off 3: Cálculo dinámico de cuotas vs ledger persistido.**
* **Ventaja actual:** menos tablas y cálculo flexible.
* **Riesgo:** no conserva historia financiera inmutable, dificulta mora, conciliación, auditoría y cambios de tasa/condiciones.

**Trade-off 4: Integraciones mock/sandbox vs proveedores reales.**
* **Ventaja actual:** reduce dependencia externa y permite avanzar en pruebas académicas.
* **Riesgo:** criterios de aceptación pueden parecer cumplidos aunque falten certificación, seguridad operacional y evidencia legal.