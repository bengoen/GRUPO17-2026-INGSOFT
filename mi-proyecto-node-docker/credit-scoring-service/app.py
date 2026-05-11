from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import joblib
import numpy as np
import math
import json
from typing import Optional, Dict, Any

app = FastAPI(title="Credit Scoring Service", version="1.0.0")

# Cargar modelo y metadata
MODEL = joblib.load('/app/credit_model.pkl')
with open('/app/model_metadata.json') as f:
    META = json.load(f)

FEATURES = META['feature_columns']
CAL = META['calibration']
FACTOR = CAL['FACTOR']
OFFSET = CAL['OFFSET']


def pd_to_score(pd_val):
    pd_val = max(0.0001, min(0.9999, pd_val))
    odds = (1 - pd_val) / pd_val
    return max(300, min(850, round(OFFSET + FACTOR * math.log(odds))))


def score_to_category(score):
    if score >= 700: return "LOW"
    elif score >= 600: return "MEDIUM"
    elif score >= 400: return "HIGH"
    else: return "REJECTED"


def score_to_rate(score):
    if score >= 750: return 0.12
    elif score >= 700: return 0.16
    elif score >= 600: return 0.22
    elif score >= 400: return 0.30
    else: return None


@app.get('/health')
def health():
    return {"status": "ok", "model_features": len(FEATURES)}


@app.post('/predict')
def predict(data: Dict[str, Any]):
    try:
        # Construir vector de features en el orden correcto
        feature_vector = []
        for feat in FEATURES:
            val = data.get(feat, None)
            if val is None or val == '':
                feature_vector.append(np.nan)
            else:
                feature_vector.append(float(val))

        X = np.array([feature_vector])
        prob_default = float(MODEL.predict_proba(X)[:, 1][0])
        score = pd_to_score(prob_default)
        category = score_to_category(score)
        rate = score_to_rate(score)

        return {
            "success": True,
            "score": score,
            "probability_of_default": round(prob_default, 4),
            "risk_category": category,
            "annual_rate": rate,
            "approved": category != "REJECTED"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
