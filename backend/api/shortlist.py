from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import JSONResponse
from typing import Optional
from ..scoring.shortlist import generate_shortlist

router = APIRouter()

SUPPORTED_MOTIONS = {"FX", "Cards", "Spend Management"}

@router.get("/api/shortlist")
def get_shortlist(
    product_motion: str = Query(..., description="Product motion to filter by (FX, Cards, Spend Management)"),
    limit: Optional[int] = Query(100, gt=0, description="Maximum number of companies to return")
):
    # Input validation
    if not product_motion or product_motion not in SUPPORTED_MOTIONS:
        raise HTTPException(status_code=400, detail="Missing or invalid product_motion parameter")
    if limit is not None and (not isinstance(limit, int) or limit <= 0):
        raise HTTPException(status_code=400, detail="Invalid limit parameter")
    try:
        companies = generate_shortlist(product_motion, limit)
        return JSONResponse(content={"companies": companies})
    except Exception:
        raise HTTPException(status_code=500, detail="Internal server error")
