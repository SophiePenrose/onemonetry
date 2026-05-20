# Internal Information Request for Prospecting App Scoring Model

I'm building an automated prospecting tool that scores and ranks mid-market companies (£15M+ turnover) based on their fit for Revolut Business products. The tool analyses Companies House filings to identify pain signals, product fit, and prioritisation factors.

I need the following information to calibrate the scoring model accurately. Please provide as much detail as possible.

---

## 1. Product Revenue & Commercial Prioritisation

For each Revolut Business product motion below, please tell me:
- Approximate GP contribution (or relative ranking from highest to lowest revenue per deal)
- Minimum annual volume/spend that makes a deal commercially viable
- Average deal cycle length
- Any specific pricing advantages vs named competitors

Products:
- FX / Multicurrency payments
- FX Forwards (hedging)
- Corporate Cards
- Spend Management
- API Integrations / Embedded Finance
- Merchant Acquiring (payment acceptance)
- Revolut Pay
- Monthly/Enterprise Plans

**Example format:**
| Product | Relative GP (1-10) | Min viable size | Avg deal cycle | Key pricing advantage |
|---------|-------------------|-----------------|----------------|----------------------|

---

## 2. Target Industries & Verticals

- Which industries/verticals does the mid-market team actively target? Are there any that perform particularly well?
- Which industries are prohibited or restricted by Revolut compliance (beyond gambling, weapons, adult entertainment, tobacco)?
- Are there specific SIC codes or company types that should be excluded?
- For each product, are there industries where fit is particularly strong? E.g. "logistics companies almost always need FX" or "retail always needs merchant acquiring"

---

## 3. Competitive Intelligence

For each major competitor in the mid-market space:
- What is their primary weakness that Revolut exploits?
- How embedded/sticky are they typically?
- What triggers a switch away from them?

Please cover:
- HSBC / Barclays / NatWest / Lloyds (traditional banks for FX, treasury)
- Worldpay / Barclaycard / Adyen / Stripe (payment processing)
- Amex / Caxton / other card providers
- SAP Concur / Pleo / Spendesk (spend management)
- Modulr / ClearBank / Stripe Connect (API/embedded)
- Wise / OFX / Moneycorp (specialist FX)

**Example format:**
| Competitor | Product they compete on | Their weakness | Switching trigger | Stickiness (1-5) |

---

## 4. Qualification & Disqualification Signals

From real deals the mid-market team has won or lost, what signals predict:

**Positive signals (predict a successful deal):**
- E.g. "New CFO appointed in last 12 months"
- E.g. "Company recently completed an acquisition"
- E.g. "Mentioned payment costs as a concern in annual report"

**Negative signals (predict a wasted meeting):**
- E.g. "Just signed a 3-year contract with incumbent"
- E.g. "Company is in administration or distressed"
- E.g. "Sub-£15M turnover with no growth trajectory"

Please list as many real-world signals as possible from the team's experience.

---

## 5. Segment-Specific Expectations

For mid-market companies (roughly £15M-£500M turnover):
- What level of decision-maker do you typically engage? (CFO, Finance Director, Treasury, Head of Payments?)
- How many stakeholders are usually involved in the buying decision?
- What's the typical onboarding timeline once a deal is agreed?
- Are there specific company characteristics that make onboarding easier or harder?

---

## 6. Product Fit Evidence Patterns

For each product, what specific things in a company's annual report or accounts filing would indicate strong fit? I need concrete patterns, not generic statements.

**FX / Multicurrency:**
- What percentage of international revenue makes a company a strong FX prospect?
- What specific countries/corridors are most valuable?
- What's the minimum monthly FX volume that's commercially interesting?

**FX Forwards:**
- What types of contracts/obligations make forwards relevant?
- What's the minimum hedgeable exposure worth pursuing?
- Are there specific industries where forwards are almost always relevant?

**Corporate Cards:**
- What employee count makes a card programme worthwhile?
- What types of spend patterns indicate card pain?
- What's the typical card programme size for a mid-market deal?

**Spend Management:**
- What organisational structure signals spend management need?
- What existing tools are you typically displacing?
- What triggers a company to look for spend management?

**API Integrations:**
- What types of businesses typically need API access?
- What ERPs or systems indicate integration opportunity?
- What's the typical API deal look like commercially?

**Merchant Acquiring:**
- What annual card processing volume is minimum viable?
- What specific payment pain signals are you looking for?
- Which incumbent PSPs are easiest to displace and why?

**Revolut Pay:**
- What makes a checkout integration worthwhile?
- What conversion metrics do you use to sell Revolut Pay?
- Is this typically sold standalone or as an add-on to acquiring?

---

## 7. Response Propensity Signals

What signals from public data (not CRM) predict that a company is likely to respond to outreach right now?
- E.g. "Just filed accounts" (they're thinking about finance)
- E.g. "Recently hired a new CFO/FD" (new broom)
- E.g. "Mentioned cost reduction in strategic report" (looking to save)
- E.g. "Just completed fundraising" (flush with cash, need banking infrastructure)

---

## 8. Deal Breakers & Hard Exclusions

What would immediately disqualify a company from the pipeline regardless of other signals?
- Specific statuses (dissolved, in administration, etc.)?
- Specific entity types (shell companies, dormant holding entities, overseas-registered)?
- Companies already being worked by another AE?
- Companies that previously rejected Revolut?
- Specific compliance/risk flags?

---

## Context for why this matters:

The tool currently has 2,763 UK mid-market companies from Companies House filings. It reads their accounts documents and scores them on product fit, commercial value, pain signals, urgency/timing, and competitive context. The scoring determines which companies appear at the top of the weekly shortlist.

Without the information above, the scoring relies on generic assumptions. With it, the model can be calibrated to match what actually predicts successful deals for the Revolut Business mid-market team.

Please provide whatever level of detail you can — even partial answers are extremely valuable for calibrating the model.
