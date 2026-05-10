import json
import os
import time
import unittest
import urllib.error
import urllib.request
from datetime import date, timedelta


BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:3000").rstrip("/")
TIMEOUT_SECONDS = float(os.environ.get("API_TEST_TIMEOUT", "10"))


def _date_years_ago(years, days_delta=0):
    today = date.today()
    try:
        target = today.replace(year=today.year - years)
    except ValueError:
        target = today.replace(year=today.year - years, month=2, day=28)
    return (target + timedelta(days=days_delta)).isoformat()


def _request_json(method, path, payload=None):
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=body,
        headers=headers,
        method=method,
    )

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = {"raw": raw}
        return exc.code, parsed
    except urllib.error.URLError as exc:
        raise AssertionError(
            f"No se pudo conectar a {BASE_URL}. Levanta la API antes de ejecutar las pruebas."
        ) from exc


class ApplicantRegistrationEndpointTests(unittest.TestCase):
    endpoint = "/api/applicants"

    @classmethod
    def setUpClass(cls):
        suffix = f"{int(time.time() * 1000)}-app"
        cls.password = "Hito3Pass123"
        cls.valid_payload = {
            "national_id": f"H3-{suffix}-OK",
            "first_name": "Test",
            "last_name": "Adulto",
            "email": f"hito3.adulto.{suffix}@example.com",
            "date_of_birth": _date_years_ago(18, -1),
            "address": "Av. Pruebas 123",
            "password": cls.password,
            "monthly_income": 850000,
        }
        cls.underage_payload = {
            "national_id": f"H3-{suffix}-MIN",
            "first_name": "Test",
            "last_name": "Menor",
            "email": f"hito3.menor.{suffix}@example.com",
            "date_of_birth": _date_years_ago(18, 1),
            "address": "Av. Pruebas 456",
            "password": cls.password,
            "monthly_income": 250000,
        }
        cls.created_applicant_id = None

    @classmethod
    def tearDownClass(cls):
        # La API no expone DELETE de applicants; se usan national_id unicos para aislar ejecuciones.
        cls.created_applicant_id = None

    def test_create_adult_applicant_at_majority_boundary(self):
        # HU004: registro de solicitante con password hasheada; frontera valida >= 18 anos.
        status, data = _request_json("POST", self.endpoint, self.valid_payload)

        self.assertEqual(status, 201, data)
        self.assertIsInstance(data.get("id"), int)
        self.assertEqual(data.get("national_id"), self.valid_payload["national_id"])
        self.assertTrue(data.get("password_hash"))
        self.assertNotEqual(data.get("password_hash"), self.password)
        self.__class__.created_applicant_id = data["id"]

    def test_reject_underage_applicant_below_majority_boundary(self):
        # HU004: registro rechaza solicitantes bajo la frontera de mayoria de edad.
        status, data = _request_json("POST", self.endpoint, self.underage_payload)

        self.assertEqual(status, 400, data)
        self.assertIn("error", data)
        self.assertIn("mayor de 18", data["error"])


class LoanRequestsEndpointTests(unittest.TestCase):
    endpoint = "/api/loan-requests"

    @classmethod
    def setUpClass(cls):
        suffix = f"{int(time.time() * 1000)}-loan"
        applicant_payload = {
            "national_id": f"H3-{suffix}-APP",
            "first_name": "Test",
            "last_name": "Prestamo",
            "email": f"hito3.prestamo.{suffix}@example.com",
            "date_of_birth": _date_years_ago(30),
            "address": "Calle Backend 789",
            "password": "Hito3Pass123",
            "monthly_income": 1200000,
        }
        status, data = _request_json("POST", "/api/applicants", applicant_payload)
        if status != 201:
            raise AssertionError(f"No se pudo crear applicant de prueba: HTTP {status} {data}")

        cls.applicant_id = data["id"]
        cls.created_loan_id = None
        cls.valid_payload = {
            "amount": 500000,
            "termMonths": 1,
            "monthlyRate": 0,
            "monthlyPayment": 501500,
            "applicantId": cls.applicant_id,
        }
        cls.no_applicant_payload = {
            "amount": 500000,
            "termMonths": 12,
            "monthlyRate": 0.015,
            "monthlyPayment": 47000,
        }

    @classmethod
    def tearDownClass(cls):
        # La API no expone DELETE de loan_requests; los datos quedan aislados por applicant unico.
        cls.created_loan_id = None
        cls.applicant_id = None

    def test_create_loan_request_with_minimum_term_boundary(self):
        # HU001: confirma simulacion y crea solicitud; frontera valida termMonths = 1.
        status, data = _request_json("POST", self.endpoint, self.valid_payload)

        self.assertEqual(status, 201, data)
        self.assertIsInstance(data.get("id"), int)
        self.assertEqual(int(data.get("term_months")), 1)
        self.assertEqual(int(data.get("applicant_id")), self.applicant_id)
        self.assertIn(data.get("status"), {"PENDING_EVAL", "PENDING"})
        self.__class__.created_loan_id = data["id"]

    def test_reject_loan_request_without_registered_applicant(self):
        # HU001: confirmar simulacion sin applicantId es clase invalida/autenticacion requerida.
        status, data = _request_json("POST", self.endpoint, self.no_applicant_payload)

        self.assertEqual(status, 401, data)
        self.assertIn("error", data)
        self.assertIn("registrarse", data["error"])


if __name__ == "__main__":
    unittest.main()
