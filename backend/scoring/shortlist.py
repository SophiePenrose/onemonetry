import json
from typing import List, Dict, Any
from .product_fit import evaluate_product_fit

MOCK_DATA_PATH = "/workspaces/onemonetry/backend/data/mock_companies.json"

def generate_shortlist(product_motion: str, limit: int = 100) -> List[Dict[str, Any]]:
    with open(MOCK_DATA_PATH) as f:
        companies = json.load(f)

    results = []
    for company in companies:
        if product_motion not in company.get("motions", []):
            continue
        fit = evaluate_product_fit(company, product_motion)
        if fit["eligible"]:
            results.append({
                "id": company["id"],
                "name": company["name"],
                "score": fit["score_contribution"],
                "product_motion": product_motion,
                "product_fit": fit,
                "explanation": fit["explanation"]
            })

    # Sort by score descending, then name ascending for deterministic order
    results.sort(key=lambda x: (-x["score"], x["name"]))
    # Assign rank
    for idx, item in enumerate(results[:limit], start=1):
        item["rank"] = idx
    return results[:limit]

# Example usage (for testing):
# print(generate_shortlist("FX"))
# print(generate_shortlist("Cards"))
# print(generate_shortlist("Spend Management"))
