from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import JSONResponse
from typing import Optional
import json
from ..scoring.product_fit import evaluate_product_fit

router = APIRouter()

MOCK_DATA_PATH = "/workspaces/onemonetry/backend/data/mock_companies.json"
SUPPORTED_MOTIONS = {"FX", "Cards", "Spend Management"}

@router.get("/api/company/{id}")
def get_company_detail(
    id: str,
    product_motion: str = Query(..., description="Product motion to evaluate (FX, Cards, Spend Management)")
):
    # Input validation
    if not product_motion or product_motion not in SUPPORTED_MOTIONS:
        raise HTTPException(status_code=400, detail="Missing or invalid product_motion parameter")
    try:
        with open(MOCK_DATA_PATH) as f:
            companies = json.load(f)
        company = next((c for c in companies if c["id"] == id), None)
        if not company:
            raise HTTPException(status_code=404, detail="Company not found")
        fit = evaluate_product_fit(company, product_motion)
        if not fit["eligible"]:
            return JSONResponse(status_code=403, content={"error": "Company does not meet current shortlist criteria"})
        # Build response
        score_breakdown = {"product_fit": fit["score_contribution"]}
        final_score = fit["score_contribution"]
        explanation = fit["explanation"]
        resp = {
            "company": {
                "id": company["id"],
                "name": company["name"],
                "company_number": company["company_number"],
                "industry": company["industry"],
                "turnover": company["turnover"],
                "employee_count": company["employee_count"],
                "latest_annual_report_url": company["latest_annual_report_url"],
                "product_fit": fit,
                "score_breakdown": score_breakdown,
                "final_score": final_score,
                "explanation": explanation
            }
        }
        return JSONResponse(content=resp)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Internal server error")
