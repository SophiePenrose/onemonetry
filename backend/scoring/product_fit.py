import json
from typing import Dict, Any, Optional

# Product-fit rubric definitions (explicit, per spec)
FX_RUBRIC = {
    "strong": lambda e: e.get("international_activity") is True,
    "weak": lambda e: e.get("international_activity") is False,
}

CARDS_RUBRIC = {
    "strong": lambda e: e.get("team_structure") == "multi-department" and e.get("finance_stack") == "fragmented",
    "weak": lambda e: e.get("team_structure") != "multi-department" or e.get("finance_stack") != "fragmented",
}

SPEND_MANAGEMENT_RUBRIC = {
    "strong": lambda e: e.get("spend_complexity") == "high" and e.get("system_fragmentation") is True,
    "medium": lambda e: e.get("spend_complexity") == "high" and e.get("system_fragmentation") is False,
    "weak": lambda e: e.get("spend_complexity") != "high",
}


def evaluate_fx(evidence: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not evidence:
        return _fail_result("FX", "absent", "No FX evidence provided.")
    if FX_RUBRIC["strong"](evidence):
        return _pass_result("FX", "strong", 1.0, "Company has international activity.")
    if FX_RUBRIC["weak"](evidence):
        return _fail_result("FX", "weak", "No international activity detected.")
    return _fail_result("FX", "absent", "FX evidence is ambiguous or missing required fields.")

def evaluate_cards(evidence: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not evidence:
        return _fail_result("Cards", "absent", "No Cards evidence provided.")
    if CARDS_RUBRIC["strong"](evidence):
        return _pass_result("Cards", "strong", 1.0, "Multi-department team and fragmented finance stack.")
    if CARDS_RUBRIC["weak"](evidence):
        return _fail_result("Cards", "weak", "Does not have both multi-department team and fragmented finance stack.")
    return _fail_result("Cards", "absent", "Cards evidence is ambiguous or missing required fields.")

def evaluate_spend_management(evidence: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not evidence:
        return _fail_result("Spend Management", "absent", "No Spend Management evidence provided.")
    if SPEND_MANAGEMENT_RUBRIC["strong"](evidence):
        return _pass_result("Spend Management", "strong", 1.0, "High spend complexity and system fragmentation.")
    if SPEND_MANAGEMENT_RUBRIC["medium"](evidence):
        return {
            "motion": "Spend Management",
            "fit_level": "medium",
            "eligible": True,
            "score_contribution": 0.7,
            "explanation": "High spend complexity but no system fragmentation."
        }
    if SPEND_MANAGEMENT_RUBRIC["weak"](evidence):
        return _fail_result("Spend Management", "weak", "Spend complexity is not high.")
    return _fail_result("Spend Management", "absent", "Spend Management evidence is ambiguous or missing required fields.")

def _pass_result(motion, fit_level, score, explanation):
    return {
        "motion": motion,
        "fit_level": fit_level,
        "eligible": True,
        "score_contribution": score,
        "explanation": explanation
    }

def _fail_result(motion, fit_level, explanation):
    return {
        "motion": motion,
        "fit_level": fit_level,
        "eligible": False,
        "score_contribution": 0.0,
        "explanation": explanation
    }

def evaluate_product_fit(company: Dict[str, Any], motion: str) -> Dict[str, Any]:
    evidence = company.get("evidence", {}).get(motion)
    if motion == "FX":
        return evaluate_fx(evidence)
    elif motion == "Cards":
        return evaluate_cards(evidence)
    elif motion == "Spend Management":
        return evaluate_spend_management(evidence)
    else:
        return _fail_result(motion, "absent", f"Motion '{motion}' not supported in MVP.")

# Example usage (for testing):
# with open("/workspaces/onemonetry/backend/data/mock_companies.json") as f:
#     companies = json.load(f)
#     for c in companies:
#         for m in c["motions"]:
#             print(c["name"], m, evaluate_product_fit(c, m))
