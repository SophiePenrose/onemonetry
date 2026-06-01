/**
 * Scoring weight constants shared across backend scoring flows.
 *
 * The 5 UI/segment layers are user-tunable and drive server-side `computeCompositeScore`
 * plus `computePriorityBreakdown`'s `segmentWeightedFit` blend. The 6-layer engine fit
 * weights are internal to `scoreCompany`'s `composite_score` and include the engine-only
 * `switching_feasibility` layer. Reconciling these two numeric sets would change
 * `composite_score`/ranking and must be done deliberately with test re-baselining (not here).
 */
export const LAYER_NAMES = ["product_fit", "commercial_value", "pain_strength", "urgency", "competitor_context"];

export const DEFAULT_SEGMENT_WEIGHTS = {
  SMB: {
    product_fit: 0.35,
    commercial_value: 0.15,
    pain_strength: 0.25,
    urgency: 0.15,
    competitor_context: 0.10,
  },
  "Mid-Market": {
    product_fit: 0.30,
    commercial_value: 0.22,
    pain_strength: 0.20,
    urgency: 0.15,
    competitor_context: 0.13,
  },
  Enterprise: {
    product_fit: 0.28,
    commercial_value: 0.25,
    pain_strength: 0.18,
    urgency: 0.14,
    competitor_context: 0.15,
  },
};

export const DEFAULT_PROPENSITY_WEIGHT = 0.15;

export const SCORING_ENGINE_FIT_WEIGHTS = {
  product_fit: 0.28,
  commercial_value: 0.18,
  pain_strength: 0.18,
  urgency: 0.14,
  competitor_context: 0.10,
  switching_feasibility: 0.12,
};
