# Revolut Business Product Knowledge Base

Purpose: source-of-truth product reference for scoring interpretation, Gemini handoff generation, YAMM copy review, and internal opportunity notes.

Generation rule: only recommend products and capabilities listed here. If a capability is not listed, mark it internally as "to be confirmed by Sophie" and do not include it in outbound copy.

## Strategic Framing

Revolut Business should be positioned as connected financial infrastructure: sales collection and capital management in one account architecture. The strongest mid-market pitch is not a list of products; it is the operational link between payment collection, multicurrency treasury, cards, spend controls, accounts payable, integrations, and the operating account.

Do not position Revolut as a full bank replacement on day one. Use language such as:

- primary operating account
- connected financial operating system
- operating layer alongside existing banking relationships
- infrastructure that can consolidate specific finance workflows over time

## Claim Policy

Use approved comparative language carefully:

- competitive rates
- transparent margins
- typically lower than high-street providers
- traditional providers often apply less favourable margins
- legacy banking infrastructure can make this more manual than it needs to be

Never guarantee pricing, savings, approval, eligibility, or outcomes. Never name competitors negatively in prospect-facing copy. Competitors may be noted in internal dossier fields only.

Pricing and plan structure are internal context unless Sophie explicitly approves quoting them:

- Basic: GBP 10/month
- Grow: from GBP 30/month
- Scale: from GBP 90/month
- Enterprise: custom
- Titan: GBP 65 + VAT/month per user

If using an illustrative saving or pricing anchor, include the relevant caveat. Product fit and evidence strength should decide whether the claim is safe enough to mention.

## Merchant Acquiring And Payments

Strategic context: acquiring is the highest-retention product in the mid-market stack because payment-rail integration creates operational commitment. FX can be a strong wedge, but acquiring plus cards plus FX creates a more durable connected-stack relationship.

### Payment Gateway (CNP)

What it does:

- Cloud e-commerce payment gateway with API integration, pre-built plugins, and hosted checkout widgets.
- Supports Visa, Mastercard, Amex where available, Apple Pay, Google Pay, Open Banking, and recurring billing.

Differentiators:

- Banking and acquiring in one dashboard.
- Settlement into Revolut Business account within 24 hours.
- Single widget can expose multiple payment methods.
- Payment methods can be toggled from dashboard.
- Multi-currency acceptance in 33+ currencies with like-for-like settlement.
- Customisable hosted payment page.

Fit signals:

- Online revenue.
- PSP/acquirer mentions.
- E-commerce platform disclosed.
- High transaction volume.
- Payment-processing cost lines.

Constraints:

- In-store POS is a separate product.
- Amex availability varies by market.
- Full API path requires engineering resource.
- Custom pricing is relevant above GBP 200k/month card sales.

### Revolut Pay

What it does:

- One-tap checkout for Revolut retail users via account-to-account or card payment in the Revolut app.

Differentiators:

- Low-friction checkout.
- Strong for consumer-heavy checkout and Revolut retail-user audiences.
- RevPoints can incentivise usage.

Fit signals:

- Consumer-facing volume.
- Young or international audience.
- Low-to-medium average order value.
- High traffic.
- Desire for express checkout.
- TPV around GBP 3m-GBP 15m.

Constraints:

- Not a full PSP replacement alone.
- Weaker for pure B2B.
- Less relevant for very high average order value.

### Open Banking (PIS)

What it does:

- Pay-by-bank checkout through open banking rails.

Differentiators:

- Lower cost profile than card acquiring.
- No chargeback model.
- Useful for high-AOV or B2B checkout flows.
- Reduces card-data handling.

Fit signals:

- High-AOV transactions.
- B2B checkout.
- Chargeback pressure.
- High card-processing cost on large transactions.

Constraints:

- Less familiar customer experience than cards for low-AOV impulse purchases.
- Conversion can be lower on small basket sizes.

### Transaction API And SDKs

What it does:

- Developer tooling for custom payment integrations, webhooks, idempotency, subscriptions, tokenisation, and complex billing logic.

Fit signals:

- SaaS or subscription business.
- Marketplace/platform model.
- In-house development team.
- Complex billing requirements.

Constraints:

- Requires engineering resource.
- Grow plan or above for API access.

### Invoicing

What it does:

- Create, send, and track invoices with embedded payment options.
- Supports card, Apple Pay, Google Pay, Pay by Bank, and bank transfer.

Fit signals:

- B2B service companies.
- Agencies, professional services, moderate invoice volumes.

Constraints:

- Not a full accounts receivable platform for high-volume automated billing.

### Payment Links

What it does:

- Shareable payment links via email, QR code, or copy/paste.

Fit signals:

- Events, services, ad hoc payments, quick collection without integration.

Constraints:

- Not for high-volume automated e-commerce or recurring billing.

### Revolut Terminal And POS

What it does:

- Card-present payments through POS hardware, Revolut Reader, and Tap to Pay on iPhone.

Approved external anchor:

- In-person processing may be referenced as "starting from 0.8% + GBP 0.02" only with caution and no guarantee language.

Fit signals:

- F&B, hospitality, retail, physical locations, in-store card acceptance, high card usage.

Constraints:

- Requires physical presence.
- Register hardware is paid.
- Terminal transaction limits apply.

### Subscriptions

What it does:

- Recurring billing engine for subscription plans, retry logic, and dunning support.

Fit signals:

- SaaS, membership, recurring revenue.

Constraints:

- Do not over-position against specialist subscription platforms unless evidence supports a simpler integrated fit.

## FX And Multi-Currency

Strategic context: FX is a fast wedge but can be transactional. Use it to open the door, then look for cards, acquiring, AP, or account architecture that creates a stronger relationship.

### Multi-Currency Accounts

What it does:

- Hold, send, and receive in 25+ currencies from one platform.
- Local account details/IBANs available in key jurisdictions.

Fit signals:

- Overseas entities.
- Foreign-currency revenue or costs.
- Intercompany balances.
- International expansion.
- Multiple banking relationships.

Constraints:

- Not a substitute where local regulation requires a domestic bank.
- Local account-detail availability varies.

### Spot FX

What it does:

- Currency conversion with transparent margins and live rates during trading hours.
- Supports order controls such as limit and stop orders.

Fit signals:

- FX gains/losses.
- Overseas suppliers.
- Foreign-currency revenue.
- Foreign exchange risk disclosure.

Constraints:

- Rates are live and not guaranteed until executed.
- Weekend markup applies outside market hours.
- Plan allowance applies.

### FX Forwards

What it does:

- Lock an exchange rate for a future date for commercial use.
- Standard tenors from 1 week to 12 months, with custom terms for larger needs.

Differentiators:

- Self-serve standard tenors.
- Transparent markup.
- Fixed-date or flexible-date contracts.
- Custom terms available for larger notionals through specialists.

Fit signals:

- Material recurring FX exposure.
- Unhedged foreign receivables/payables.
- Financial risk section mentions no hedging.
- Intercompany foreign-currency loans.
- Revenue and costs in different currencies.

Constraints:

- Commercial use only.
- Deposit requirements apply.
- Margin calls are possible.
- Standard contracts have notional and currency constraints.
- Do not present as speculative trading.

## Cards And Spend Management

Strategic context: cards are a strong cross-sell and a natural control layer for employee spend, travel, SaaS, marketing, subscriptions, and distributed budget ownership.

### Corporate Cards

What it does:

- Physical Visa debit cards for employees with Apple Pay and Google Pay support.

Differentiators:

- Real-time visibility.
- Freeze/unfreeze.
- MCC, country, per-card, and time-based controls.
- High per-card limits where appropriate.

Fit signals:

- High staff costs.
- T&E.
- Employee travel.
- Advertising/marketing spend.
- Expense-management pain.
- Multiple budget holders.

Constraints:

- Debit-funded, not a credit card.

### Virtual Cards

What it does:

- Instantly issued digital cards for online spend.

Differentiators:

- One card per vendor/campaign for reconciliation.
- Disposable cards.
- Budget-bound controls.
- Useful for SaaS subscriptions and digital ads.

Fit signals:

- SaaS/software subscriptions.
- Digital advertising.
- Supplier payments where card is preferred.
- Fraud containment.

Constraints:

- Online-only and not accepted by every merchant.

### Spend Management Platform

What it does:

- Approval workflows, budgets, policy controls, receipt capture, analytics, and accounting sync.

Fit signals:

- High admin costs.
- Multiple teams or departments.
- Manual expense claims.
- Accounting software usage.
- More than 10 employees with spending needs.

Constraints:

- Full feature set requires Grow plan or above.
- Advanced workflows depend on plan.

## BillPay And Accounts Payable

Strategic context: BillPay helps move outbound bank payments and AP workflows into the primary operating account, strengthening retention and cross-product usage.

### BillPay

What it does:

- Invoice capture, OCR extraction, approvals, payment execution, and two-way accounting sync.

Differentiators:

- Supplier memory.
- Duplicate warnings.
- Scheduled, immediate, partial, and bulk bill payments.
- Early payment workflows where available.

Fit signals:

- High supplier-invoice volume.
- Many suppliers/vendors.
- Manual AP.
- Accounting software.
- Retail, F&B, hospitality, manufacturing, real estate.

Constraints:

- Integration depth varies.
- Accounting sync requires Grow plan or above.

### Bulk Payments

What it does:

- Pay up to 1,000 suppliers with a single file upload.

Fit signals:

- Supplier payment runs.
- Payroll-style batches.
- CSV or ISO pain.001 file workflows.

Constraints:

- Scale plan or above.
- File format compatibility required.

### Supplier Payments

What it does:

- Local and international supplier transfers through domestic schemes, SEPA, SWIFT, and local rails.

Fit signals:

- Domestic/international suppliers.
- Overseas supply chain.
- Expensive SWIFT-style payment workflows.

Constraints:

- Fees apply above plan allowance.
- Corridor speed varies.

## Travel And VCN

### Travel Cards

What it does:

- Virtual card numbers per booking, with MCC/date/merchant/country controls and booking labels.

Fit signals:

- TMCs, OTAs, DMCs.
- Significant corporate travel.
- Hospitality.
- Booking systems or travel-management tooling.

Constraints:

- Only relevant with meaningful travel spend or compatible travel workflows.

## Titan

Strategic context: Titan is a per-user premium add-on, not a core plan tier and not a door-opener. It can support executive relationship-building where travel and premium value are relevant.

What it includes:

- Premium Titan card.
- RevPoints.
- Unlimited airport lounge access.
- Airport fast track.
- 10GB global eSIM data.
- Business travel insurance.
- Purchase protection.
- Lifestyle subscriptions.
- Expense-management fee waiver for Titan members.

Fit signals:

- Founder-led or executive-led businesses.
- Frequent executive travel.
- Senior stakeholder relationship anchor.
- Existing premium card context.
- GBP 2k+/month card spend where points become meaningful.

Constraints:

- Do not lead with Titan.
- Typically 1-5 cards, not mass rollout.
- UK-first availability.

## Integrations And Back Office

### Accounting Integrations

What it does:

- Bank feeds, expense sync, and BillPay sync with Xero, QuickBooks, FreeAgent, NetSuite, Dynamics 365 Business Central, Sage, Odoo, and Zoho Books.

Fit signals:

- Finance team.
- Reconciliation pain.
- Multiple bank accounts.
- Manual data entry.
- Accounting software.

Constraints:

- Integration depth varies.
- Full integration requires Grow plan or above.

### Business API

What it does:

- REST API with OAuth 2.0/JWT, webhooks, data export, custom automation, card management, transaction monitoring, and sandbox.

Fit signals:

- In-house technical capability.
- Complex operations.
- Custom BI/reporting.

Constraints:

- Requires Grow/Scale/Enterprise plan and technical capability.

### Analytics

What it does:

- Financial analytics dashboard for cash flow, income, spending, merchant revenue, currency, and timeframe views.

Fit signals:

- Budgeting, visibility, cash-flow management.

Constraints:

- Grow/Scale/Enterprise plan.
- Usually a hygiene multiplier, not the lead angle.

## Lending And Credit

### Revolut Business Lending

What it does:

- Revenue-based or card-linked credit lines with flexible repayment.

Fit signals:

- Working-capital strain.
- Overdraft reliance.
- Seasonal cash cycles.
- Rapid growth outpacing cash generation.
- Tight liquidity.

Constraints:

- Subject to credit assessment.
- Not available to all businesses.
- Facility size may not match larger needs.
- Do not promise availability or approval.
- Do not lead with lending as the primary pitch.

## Transfers And Payroll

### Local Transfers

What it does:

- SEPA, domestic GBP, and domestic schemes in multiple countries.

Fit signals:

- Salaries, suppliers, tax, domestic payment workflows.

Constraints:

- Some domestic schemes are not supported in all markets.

### International Transfers

What it does:

- SWIFT and local rails to 150+ destinations in 30+ currencies.

Fit signals:

- Overseas suppliers, staff, subsidiaries, cross-border payments.

Constraints:

- Fees apply above plan allowance.
- Some corridors are slower than others.

### Instant Revolut-To-Revolut Transfers

What it does:

- Zero-fee instant transfers to Revolut Business or Retail recipients.

Fit signals:

- Suppliers, partners, or employees using Revolut.

Constraints:

- Recipient must have Revolut.

### Payroll

What it does:

- Pay UK employee salaries from Revolut Business and support straightforward gross/net, tax, NI, pension, HMRC reporting, and pension CSV export.

Fit signals:

- UK companies with straightforward payroll and consolidation needs.

Constraints:

- UK-focused.
- Not a replacement for complex payroll systems in large teams.

## Product Recommendation Rules

- Prefer 1-2 explicit product mentions in any single email.
- Use connected-stack language to imply the broader 2-3 product arc where evidence supports it.
- Do not force acquiring without card-acceptance or commerce evidence.
- Do not force FX without international or currency evidence.
- Do not force BillPay without supplier/AP complexity.
- Do not force Titan as a first-message angle.
- Do not lead with integrations unless reconciliation/process pain is central.
- Do not lead with lending unless Sophie explicitly requests a credit-led approach.

