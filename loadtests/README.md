# Pruebas de carga con Apache JMeter

Sistema bajo prueba: **Tu Prestamo Digital** (`mi-proyecto-node-docker`).

Este directorio contiene el plan de pruebas de performance/carga solicitado para el hito. El archivo JMeter principal es `tu-prestamo-performance-plan.jmx`.

## Pruebas disenadas

El plan contiene tres pruebas. Para la ejecucion de evidencia se dejo activa solo la prueba de HU001.

| ID | HU / flujo | Endpoint principal | Carga propuesta | Resultado esperado |
| --- | --- | --- | --- | --- |
| LT-01 | HU001: registrar/login/crear solicitud | `POST /api/loan-requests` | Carga escalonada hasta encontrar degradacion | `201 Created` y response time menor a 1000 ms. |
| LT-02 | HU002: consultar solicitudes propias | `GET /api/loan-requests` | 150 usuarios, ramp-up 20 s | `200 OK` y response time menor a 800 ms. |
| LT-03 | HU010: validar carga financiera | `POST /api/scoring/validate-burden` | 200 usuarios, ramp-up 20 s | `200 OK` y response time menor a 500 ms. |

## Prueba ejecutada

Se ejecuto `LT-01` porque representa el flujo mas critico de negocio: registro de solicitante, autenticacion con cookie `app_auth`, escritura en PostgreSQL y creacion de solicitud de prestamo.

No se modifico el codigo de la aplicacion ni se bajo el umbral para que la prueba pasara. El umbral se mantuvo en 1000 ms y se aumento la carga hasta observar el punto donde el sistema dejo de cumplirlo.

## Ejecucion

Levantar la aplicacion:

```powershell
cd .\mi-proyecto-node-docker
docker compose build app
docker compose up -d postgres_db
docker compose up -d --no-deps app
cd ..
```

Ejemplo de ejecucion escalonada en Docker:

```powershell
$loadtests = (Resolve-Path ".\loadtests").Path
foreach ($users in @(75, 90, 95, 100, 150, 200, 250)) {
  docker run --rm --network mi-proyecto-node-docker_default `
    -v "${loadtests}:/loadtests" justb4/jmeter:5.5 `
    -n -t /loadtests/tu-prestamo-performance-plan.jmx `
    -l "/loadtests/results/hu001-$($users)u-10s.jtl" `
    -j "/loadtests/results/jmeter-$($users)u-10s.log" `
    -Jhost=app -Jport=3000 "-Jusers=$($users)" -Jramp=10
}
```

Generar resumen y grafico:

```powershell
python .\loadtests\analyze_jmeter_results.py
```

## Resultado obtenido

Se ejecuto una busqueda escalonada con ramp-up fijo de 10 segundos. La cifra `100 usuarios / 30 s` de la pauta se considero solo referencial; para encontrar degradacion real se redujo el ramp-up y se probaron niveles crecientes.

| Usuarios | Ramp-up | Muestras `POST /api/loan-requests` | Promedio | Maximo | Veces sobre 1000 ms | Resultado |
| --- | --- | --- | --- | --- | --- | --- |
| 75 | 10 s | 75 | 38.89 ms | 321 ms | 0 | Cumple |
| 90 | 10 s | 90 | 162.60 ms | 430 ms | 0 | Cumple |
| 95 | 10 s | 95 | 328.61 ms | 667 ms | 0 | Cumple |
| 100 | 10 s | 100 | 521.94 ms | 1077 ms | 1 | Primer quiebre observado |
| 150 | 10 s | 150 | 2598.12 ms | 4923 ms | 130 | No cumple |
| 200 | 10 s | 200 | 4341.69 ms | 8674 ms | 181 | No cumple |
| 250 | 10 s | 250 | 6014.30 ms | 11433 ms | 229 | No cumple |

Grafico generado: `response_time_hu001.png`.

Resumen generado: `results/hu001-summary.json`.

## Razonamiento

El sistema cumple hasta 95 usuarios con ramp-up de 10 segundos. El primer quiebre observado ocurre con 100 usuarios en 10 segundos: 1 de 100 solicitudes de `POST /api/loan-requests` supero el umbral de 1000 ms. Desde 150 usuarios la degradacion se vuelve evidente: 130 de 150 solicitudes superaron el umbral.

La causa probable no es el endpoint de creacion de solicitud de manera aislada, sino la presion del flujo completo sobre la misma aplicacion Node.js: cada usuario se registra, inicia sesion y luego crea la solicitud. El registro usa hashing de password con `bcrypt`, lo que consume CPU; al aumentar la concurrencia, el event loop y las conexiones a PostgreSQL empiezan a acumular espera. Por eso, aunque `POST /api/loan-requests` solo valida sesion e inserta una fila, su response time se degrada cuando el flujo completo carga la aplicacion.

La prueba no fue acomodada para pasar. Se dejo evidencia tanto de los casos que cumplen como de los que rompen el resultado esperado, porque el objetivo era encontrar bajo que condiciones el sistema deja de responder dentro del tiempo definido.
