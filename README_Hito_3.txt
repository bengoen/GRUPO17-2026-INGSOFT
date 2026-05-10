
1. Resumen de cambios hechos en este hito

- Se reviso el contexto de la Wiki y el codigo disponible en mi-proyecto-node-docker.
- Se selecciono una HU pendiente de Ingenieria de Software 2026-1 para priorizar su futura implementacion.
- Se descompuso la HU seleccionada en tareas tecnicas concretas.
- Se agrego la carpeta tests/ con pruebas Python usando unittest:
  - tests/test_hito3_endpoints.py
- Se diseñaron 4 casos de prueba sobre 2 endpoints operativos:
  - POST /api/applicants
  - POST /api/loan-requests
- Las pruebas usan clases de equivalencia y valores frontera, e incluyen respuestas exitosas y excepcionales.
- Se sincronizo mi-proyecto-node-docker/package-lock.json con la dependencia nodemailer ya declarada en package.json, necesaria para que la app arranque con los workers de notificaciones existentes.

Ejecucion esperada:

1. Levantar la aplicacion:
   cd mi-proyecto-node-docker
   docker compose up --build

2. En otra terminal, desde la raiz del repositorio:
   python -m unittest discover -s tests

Resultado local verificado:
   Ran 4 tests in 0.176s
   OK


2. Seleccion de HU pendiente y justificacion

HU seleccionada: HU010 - Visualizacion del Scoring de Riesgo al Solicitar Prestamo.

Justificacion:
Se prioriza HU010 porque impacta directamente el momento mas critico del flujo principal del sistema: la decision de solicitar un prestamo. A diferencia de HU007 y HU008, no depende de integraciones externas pesadas como OCR, marketing masivo o carga documental. Ademas, complementa naturalmente HU001, HU003 y HU004, ya que puede calcularse usando datos ya disponibles: monto, plazo, ingreso declarado, perfil del solicitante e historial financiero opcional. Entrega valor visible al cliente y permite advertir riesgos antes de crear deuda.

Tareas tecnicas para futura implementacion de HU010:

1. Definir regla de negocio del scoring:
   - Rango de puntaje, por ejemplo 0 a 1000.
   - Niveles legibles: bajo, medio, alto.
   - Umbrales de advertencia visual y recomendacion.
   - Variables base: monto solicitado, plazo, cuota estimada, ingreso mensual y antecedentes financieros.

2. Crear servicio backend de scoring:
   - Nuevo modulo sugerido: mi-proyecto-node-docker/src/services/riskScoring.js.
   - Funcion pura para calcular puntaje y razones del resultado.
   - Salida estructurada: score, level, recommendation, reasons.

3. Persistir el resultado en base de datos:
   - Agregar migracion SQL para loan_requests:
     - risk_score INTEGER
     - risk_level TEXT
     - risk_reasons JSONB
     - score_calculated_at TIMESTAMPTZ

4. Integrar scoring con la creacion de solicitudes:
   - Extender POST /api/loan-requests para calcular scoring al confirmar simulacion.
   - Usar applicantId para obtener ingreso y datos del solicitante.
   - Guardar el scoring junto con la solicitud.

5. Exponer endpoint de consulta:
   - GET /api/loan-requests/:id/scoring
   - Debe devolver solo el scoring de solicitudes existentes.
   - Debe retornar 404 si la solicitud no existe.

6. Actualizar vistas existentes:
   - Mostrar score en el resumen del simulador antes de confirmar.
   - Mostrar score en /requests/:id.
   - Usar alerta visual clara para score bajo y refuerzo positivo para score alto.

7. Agregar pruebas:
   - Unit tests del servicio de scoring.
   - Tests de endpoint para score alto, score bajo y solicitud inexistente.

8. Documentar en Wiki/README:
   - Regla de negocio utilizada.
   - Endpoints agregados.
   - Evidencias y limitaciones del prototipo.


3. Casos de prueba diseñados

Caso 1 - Registro exitoso de solicitante adulto

| Campo | Detalle |
|---|---|
| HU asociada | HU004 - Registro, Autenticacion y Gestion de Perfil |
| Endpoint | POST /api/applicants |
| Clase de equivalencia / frontera | Valido. Solicitante adulto justo sobre la frontera de mayoria de edad: 18 anios + 1 dia. |
| Input | JSON con national_id unico, first_name, last_name, email, date_of_birth calculado dinamicamente, address, password y monthly_income. |
| Salida esperada | HTTP 201. Respuesta con id entero, national_id igual al enviado y password_hash presente/distinto a la password original. |
| Contexto de ejecucion | API Node/Express levantada en http://localhost:3000 con PostgreSQL disponible. No requiere usuario previo. |

Caso 2 - Rechazo de solicitante menor de edad

| Campo | Detalle |
|---|---|
| HU asociada | HU004 - Registro, Autenticacion y Gestion de Perfil |
| Endpoint | POST /api/applicants |
| Clase de equivalencia / frontera | Invalido. Solicitante bajo la frontera de mayoria de edad: 18 anios - 1 dia. |
| Input | JSON completo con national_id unico, datos personales obligatorios y date_of_birth calculado como menor de edad. |
| Salida esperada | HTTP 400. Respuesta JSON con error que contiene "mayor de 18". |
| Contexto de ejecucion | API y base de datos levantadas. Caso excepcional esperado por regla de negocio. |

Caso 3 - Creacion exitosa de solicitud con plazo minimo

| Campo | Detalle |
|---|---|
| HU asociada | HU001 - Simular y Crear Solicitud de Prestamo |
| Endpoint | POST /api/loan-requests |
| Clase de equivalencia / frontera | Valido. Solicitud asociada a applicantId existente con frontera inferior de plazo: termMonths = 1. |
| Input | JSON con amount 500000, termMonths 1, monthlyRate 0, monthlyPayment 501500 y applicantId creado en setUpClass. |
| Salida esperada | HTTP 201. Respuesta con id entero, term_months = 1, applicant_id igual al applicant creado y status pendiente (PENDING_EVAL o PENDING segun esquema cargado). |
| Contexto de ejecucion | setUpClass crea primero un solicitante valido via POST /api/applicants. Luego se confirma la simulacion como solicitud. |

Caso 4 - Rechazo de solicitud sin applicantId

| Campo | Detalle |
|---|---|
| HU asociada | HU001 - Simular y Crear Solicitud de Prestamo |
| Endpoint | POST /api/loan-requests |
| Clase de equivalencia / frontera | Invalido. Payload funcionalmente completo, pero sin identidad/autenticacion del solicitante. |
| Input | JSON con amount, termMonths, monthlyRate y monthlyPayment, omitiendo applicantId. |
| Salida esperada | HTTP 401. Respuesta JSON con error que contiene "registrarse". |
| Contexto de ejecucion | API levantada. Representa la precondicion de HU001 integrada con HU004: solo usuarios registrados pueden confirmar la simulacion. |

