**Asunto: Resumen de estado Hito 4 - Qué está listo y qué falta**

Buena cabros, les dejo el resumen de lo que ya dejé listo por mi parte para el Hito 4 y lo que nos falta hacer en el código para terminar de cumplir con la rúbrica.

### está LISTO (Documentación y Arquitectura)

Ya hice toda la parte de análisis y gestión en GitHub para justificar nuestros cambios:

* **Análisis ATAM:** Creé y subí el archivo `README_Hito_4.md` a la raíz del repo con los concerns, trade-offs y riesgos de la arquitectura.
* **Wiki Actualizada:** Reformulé las historias **HU004, HU005 y HU003** en la Wiki, agregando la justificación técnica de por qué hay que cambiarlas y metiendo los pantallazos de evidencia (ej. el `applicantId` guardado de forma insegura).
* **Trazabilidad en Issues:** Dejé los comentarios respectivos en los Issues originales de GitHub de cada HU con los nuevos criterios de aceptación y la evidencia visual.

### Lo que FALTA HACER (Código - Para ustedes)

Falta chambear el codigo

* **1. Seguridad y Autenticación (HU004):** Hay que sacar el `applicantId` del `localStorage`. Tienen que implementar sesiones reales en el backend de Node (puede ser con `express-session` o JWT) y proteger los endpoints para que tiren error 401/403 si el usuario no está logueado o intenta ver cosas de otro usuario.
* **2. Ledger de Cuotas y Mora (HU005):** Las cuotas se están calculando al vuelo. Hay que crear una tabla real en PostgreSQL para que las cuotas queden guardadas (ledger) al momento de aprobar el préstamo. Además, conectar bien eso con los pagos de Webpay e implementar un cálculo simple de mora si la cuota está vencida.
* **3. Firma Digital e Idempotencia (HU003):** Mejorar la validación de la firma del contrato. Asegurarse de que el cambio de estados sea robusto (idempotente) para que, si el usuario hace clic varias veces, no se dupliquen los eventos de "Contrato Firmado" en la base de datos.

### Registro de Horas

Por favor, a medida que vayan terminando sus tareas de código, **anoten cuántas horas exactas se demoraron**.
Anoten este tiempo en el Issue "Registro de Trabajo Realizado - Hito 4".
