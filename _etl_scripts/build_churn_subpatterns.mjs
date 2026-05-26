#!/usr/bin/env node
/**
 * Tag every churned customer with sub-patterns within their primary churn-reason cluster.
 *
 * Why: the Failed Implementation and Features buckets are big enough that the top-level reason
 * isn't actionable on its own ("Failed Implementation" doesn't tell us WHICH initiative to fund).
 * This script reads the evidence we already have (customer_profiles.churn_reason +
 * churn_inferences.suggested_reason / evidence_quote + Churn Details.xlsx CS-rep notes) and
 * applies keyword-based sub-pattern detection.
 *
 * Output: public/snapshots/churn_subpatterns.json. The dashboard reads this and surfaces the
 * sub-patterns as filter chips inside each cluster drill-down.
 *
 * Sub-patterns are not mutually exclusive — a customer can match more than one (e.g.,
 * bandwidth_stalled + diy_attempt_failed).
 */

import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs';

const SNAP = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/public/snapshots';
const CHURN_XLSX = '/Users/beaulewis/projects/2 - Allmoxy - CFO/Churn Details.xlsx';

// Sub-pattern catalog. Each entry: { label, parent_reason, description, regex[] }
// regex[] is matched (case-insensitive) against the combined evidence blob for each customer.
// `parent_reason` is the top-level Churn Playbook reason this sub-pattern belongs to. The
// dashboard only shows a sub-pattern when its parent matches the cluster being drilled into.
const SUBPATTERNS = {
  // === Failed Implementation sub-patterns ===
  fi_bandwidth_stalled: {
    label: 'Bandwidth stalled',
    parent: 'Failed Implementation',
    description: 'Owner could not dedicate the time. Implementation paused indefinitely, never resumed.',
    regex: [
      /not (have|enough).{0,15}time/i, /lack of time/i, /didn'?t have time/i, /no.{0,5}bandwidth/i,
      /pause.{0,30}implement/i, /granted a pause/i, /can'?t.{0,10}do.{0,10}anymore/i,
      /no.{0,5}power.{0,5}factory/i, /personell to man/i, /head space/i, /circle.{0,10}back/i,
      /circling back/i, /too busy/i, /swamped/i, /not.{0,5}have.{0,5}available bandwidth/i,
      /hasn'?t been able to get there/i,
    ],
  },
  fi_diy_attempt_failed: {
    label: 'DIY attempt failed',
    parent: 'Failed Implementation',
    description: "Customer chose self-build at signup, struggled, then refused to engage paid services.",
    regex: [
      /won'?t utilize.{0,20}services/i, /not willing to pay for services/i, /unwilling to pay for services/i,
      /don'?t want to invest the resources to have a 3rd p/i,
      /never used services team/i, /attempted to set up on (his|her|their|my) own/i,
      /build.{0,15}on (his|her|their|my) own/i, /set ?up on own/i,
    ],
  },
  fi_cs_responsiveness: {
    label: 'Allmoxy CS dropped ball',
    parent: 'Failed Implementation',
    description: 'CSM team failed to respond, lost the train, missed comms, or wrong stakeholder targeted by our side.',
    regex: [
      /no.{0,5}one.{0,5}answered/i, /no.{0,5}one.{0,5}responded/i, /never delivered/i,
      /cs.{0,5}sucks/i, /customer service.{0,20}sucks/i, /not heard/i, /unheard/i, /hard ass/i,
      /delay.{0,10}response/i, /lag/i, /time period.{0,20}lag/i, /we both had issues/i,
      /minimal communication.{0,5}to our cs/i, /uneresponsive  $/i, /cs (was|were) unresponsive/i,
      /missed a communication/i, /we were so thin/i, /felt mis ?treated/i, /felt mistreated/i,
      /email was incorrect/i, /no cs contact since/i,
    ],
  },
  fi_sales_overpromise: {
    label: 'Sales over-promise',
    parent: 'Failed Implementation',
    description: 'Customer believed they were buying features or integrations that did not really exist.',
    regex: [
      /were led to believe/i, /sold (him|her|us|them|me) on/i, /misrepresent/i,
      /software was misrepresented/i, /sold a 3d designer that solved/i,
      /didn'?t realize.{0,30}(cost|fee|upfront)/i, /complete waste of our time/i,
      /supposed to.{0,30}(work|interface|integrate)/i,
    ],
  },
  fi_third_party_services_quality: {
    label: '3rd-party services quality',
    parent: 'Failed Implementation',
    description: "Catalog built by an affiliate / outsourced contractor who got it wrong or lacked expertise.",
    regex: [
      /3rd party service provider.{0,30}(charged|set him up)/i, /third party catalog provider/i,
      /jeff (didn'?t know|did not know)/i, /hired someone to (do|set)/i, /hired.{0,30}consultant/i,
      /hired a microvellum consultant/i, /backend.{0,20}access/i,
    ],
  },
  fi_wrong_stakeholder: {
    label: 'Wrong stakeholder / owner not in loop',
    parent: 'Failed Implementation',
    description: 'Owner / decision-maker wasn’t involved; middle-manager started without authority, or multi-stakeholder confusion.',
    regex: [
      /owner not in the loop/i, /budget not approved/i, /manager (poking around|trying it passively)/i,
      /not.{0,5}the (right|decision) (guy|person|maker)/i, /kicked the can/i,
      /found out what was going on/i,
    ],
  },
  fi_no_catalog_definition: {
    label: 'Catalog not yet defined',
    parent: 'Failed Implementation',
    description: 'Customer didn’t have a defined SKU/product structure to map into Allmoxy; they wanted Allmoxy to figure it out for them.',
    regex: [
      /define.{0,15}catalog offering/i, /horse in front of the cart/i, /catalog unidentified/i,
      /they need to first define/i, /haven'?t had success setting up the catalog/i,
      /catalog.{0,10}not.{0,5}defined/i, /lost steam.{0,15}motivat/i,
    ],
  },
  fi_setup_cost_shock: {
    label: 'Setup-cost sticker shock',
    parent: 'Failed Implementation',
    description: 'Customer agreed to monthly subscription but flinched at the integration / build-out quote.',
    regex: [
      /didn'?t realize.{0,30}upfront cost/i, /upfront cost.{0,20}build out/i,
      /\$150.{0,5}(per ?hour|\/hour|\/?hr)/i, /service fees/i, /integration cost/i,
      /couldn'?t justify the integration cost/i, /not able to bear the setup costs/i,
    ],
  },
  fi_feature_gap_blocked: {
    label: 'Product feature gap blocked launch',
    parent: 'Failed Implementation',
    description: 'A real product limitation prevented the customer from launching, despite both sides trying.',
    regex: [
      /3d designer.{0,30}(issue|problem|broken|reliability|not working)/i, /3d designer issues/i,
      /dynamic attributes/i, /validations are too clunky/i, /order level functionality/i,
      /folders not/i, /part number.{0,30}quickbooks/i, /herculean effort/i,
      /export.{0,15}(bug|issue|missing)/i, /exporter.{0,15}bug/i,
      /allmoxy cannot interface with 2020/i, /microvellum exporter/i, /b2b.{0,10}feature.{0,30}built/i,
      /order level setting.{0,30}b2b/i, /dev-?\d{4}/i,
    ],
  },
  fi_customer_team_turnover: {
    label: 'Customer team turnover mid-impl',
    parent: 'Failed Implementation',
    description: 'Key staff or management on the customer side left, halting progress.',
    regex: [
      /team.{0,5}(left|leave|departed)/i, /mgmt leave/i, /retain.{0,10}employees/i,
      /ceo.{0,30}left/i, /owner.{0,30}left/i, /partner.{0,30}left/i,
    ],
  },
  fi_enduser_adoption_failure: {
    label: 'End-user adoption failure',
    parent: 'Failed Implementation',
    description: 'Allmoxy was built and live, but the customer’s own customers (dealers, end-users) wouldn’t adopt it.',
    regex: [
      /customers.{0,30}(won'?t|wouldn'?t).{0,10}adopt/i, /customers never really adopted/i,
      /in house staff did not subscribe/i, /motivating clients to use/i,
      /clients won'?t buy.{0,20}if he uses allmoxy/i,
    ],
  },
  fi_financial_distress: {
    label: 'Financial distress masked as failed impl',
    parent: 'Failed Implementation',
    description: 'Customer was running out of money during implementation; payments failing.',
    regex: [
      /financial.{0,15}(trouble|distress|tight|hardship)/i, /broke/i,
      /card.{0,15}(failing|failed permanently)/i, /lawsuit.{0,30}builder/i,
      /closed.{0,10}door/i, /closing.{0,10}door/i, /business is struggling/i,
      /horrible year/i, /going under/i, /short.{0,5}employees due to/i,
    ],
  },

  // === Features bucket sub-patterns ===
  feat_3d_designer: {
    label: '3D Designer reliability / accuracy',
    parent: 'Features',
    description: '3D designer rendering accuracy, custom moldings, complex shapes, broken outputs.',
    regex: [
      /3d designer/i, /3d.{0,5}design/i, /molding profile/i, /custom molding/i,
      /3d visualizer/i, /visual.{0,15}(renderings|configurator|aspect)/i, /list-based/i,
      /3d.{0,15}aspect/i,
    ],
  },
  feat_export_integration: {
    label: 'Cabinet Vision / Microvellum / 2020 export',
    parent: 'Features',
    description: 'Customer needed export to a downstream design/MRP tool that Allmoxy couldn’t produce cleanly.',
    regex: [
      /cabinet vision.{0,30}export/i, /microvellum.{0,30}export/i, /2020.{0,30}integrat/i,
      /2020.{0,30}interface/i, /cannot interface with 2020/i, /export.{0,15}(bug|missing|miss|wrong|broken|incomplete)/i,
      /integrated with 2020/i, /more compatible with granite/i, /stone profits/i,
    ],
  },
  feat_inventory_erp: {
    label: 'Inventory / ERP / barcoding',
    parent: 'Features',
    description: 'Customer expected ERP-grade features (inventory tracking, barcoding, production capacity) that Allmoxy isn’t built for.',
    regex: [
      /inventory management/i, /inventory tracking/i, /barcode/i, /erp/i, /production capabilities/i,
      /built their own erp/i, /odoo/i, /vesta/i,
    ],
  },
  feat_reports: {
    label: 'Reporting depth missing',
    parent: 'Features',
    description: 'Customer cited insufficient reports as the gap.',
    regex: [
      /not enough reports/i, /strain on (the )?reporting/i, /reports?.{0,15}(missing|gap|insufficient)/i,
      /report.{0,15}they need/i,
    ],
  },
  feat_dynamic_attributes_validations: {
    label: 'Dynamic attributes / validation rigidity',
    parent: 'Features',
    description: 'Attribute model / validation system too rigid for the customer’s catalog complexity.',
    regex: [
      /dynamic attributes/i, /validations are too clunky/i, /order level functionality/i,
      /drop down lists.{0,30}universal/i, /import function did not meet/i,
      /validations? (off|incorrect|inconsistent|incomplete)/i, /folders not/i,
      /attribute.{0,15}(label|flipped|unclear|confusing|broken)/i,
    ],
  },
  feat_b2b: {
    label: 'B2B features missing',
    parent: 'Features',
    description: 'B2B-specific gaps: order-level settings, multi-currency, dealer flows.',
    regex: [
      /b2b function/i, /b2b instance/i, /order level setting.{0,30}b2b/i,
      /multi.{0,5}currency/i, /canadian to us currency/i,
    ],
  },
  feat_pricing_formula_bugs: {
    label: 'Pricing-formula / catalog accuracy bugs',
    parent: 'Features',
    description: 'Customer launched but the catalog priced wrong / cut-list calculations were inaccurate.',
    regex: [
      /pricing.{0,15}(off|wrong|err|inaccurate)/i, /priced way too/i, /\$0.{0,10}for certain/i,
      /pricing at 0/i, /pricing at \$0/i, /formula.{0,15}(not|wrong|broken|incorrect)/i,
      /cut.?list.{0,15}(accuracy|wrong|inaccurate|broken)/i, /never pricing properly/i,
      /panel height/i, /arch door/i, /toe kick.{0,15}calcul/i,
    ],
  },
  feat_api_integration: {
    label: 'API / custom integration gap',
    parent: 'Features',
    description: 'Customer wanted API or custom integration that wasn’t available or wasn’t prioritized.',
    regex: [
      /api was a key/i, /api.{0,15}(integration|missing|not done|not done yet)/i,
      /custom integration/i, /webhook.{0,15}(missing|not)/i,
    ],
  },
  feat_accounting_part_numbers: {
    label: 'Part numbers / QuickBooks fields missing',
    parent: 'Features',
    description: 'Customer needed line-item part numbers or QuickBooks-tracking fields the system didn’t produce.',
    regex: [
      /part number/i, /quickbooks tracking/i, /quickbooks.{0,15}(integration|sync|export|reconcile)/i,
    ],
  },
  feat_business_model_mismatch: {
    label: 'Wrong-shape product for their business',
    parent: 'Features',
    description: 'Customer’s product type (granite, project-based, etc.) wasn’t well-served by Allmoxy.',
    regex: [
      /product type is granite/i, /granite product/i, /project based system/i,
      /(more |very )custom.{0,30}(product offering|business)/i,
      /too custom for the product/i, /too custom for our product/i,
      /not a fit for their business model/i, /not.{0,5}fit.{0,5}the mold/i,
    ],
  },
  feat_competitor_better_fit: {
    label: 'Competitor cited as better fit',
    parent: 'Features',
    description: 'Customer named a specific competitor that fit their needs better.',
    regex: [
      /knowify/i, /stone profits/i, /closet pro/i, /door pro/i, /knowify/i,
      /moved to.{0,30}(software|platform|solution)/i, /built their own/i,
      /home.?grown system/i,
    ],
  },
  feat_unspecified: {
    label: '(Reason not given / vague)',
    parent: 'Features',
    description: 'Tagged Features Missing in HubSpot or by CS, but no specific feature named.',
    regex: [/would not provide reason/i, /see comments/i, /i ?couln'?t get it to do what/i],
  },
};

function loadJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function normalize(s) {
  if (!s) return '';
  return String(s).toLowerCase().trim()
    .replace(/\.(com|net|org|ca)/g, '')
    .replace(/\b(llc|l\.?l\.?c|inc|corp|corporation|ltd|limited|co|company|lp|llp|pllc|gmbh|sa|sas|s\.l|de cv|inc\.)\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// --- Pull CS-rep records from Churn Details.xlsx ---
function loadCsRecords() {
  if (!fs.existsSync(CHURN_XLSX)) return [];
  const wb = XLSX.read(fs.readFileSync(CHURN_XLSX), { type: 'buffer' });
  const out = [];
  // Sheet5: 3 cols no header (Customer, Category, Notes)
  if (wb.Sheets['Sheet5']) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['Sheet5'], { header: 1, defval: null });
    for (const r of rows) if (r[0]) out.push({ customer: r[0], category: r[1], notes: r[2], year: null });
  }
  for (const y of ['2024', '2023', '2022']) {
    if (!wb.Sheets[y]) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[y], { defval: null });
    for (const r of rows) {
      if (!r.Customer) continue;
      out.push({
        customer: r.Customer,
        category: r['Churn Reason'] || r['Cancellation Reason'],
        notes: r['Cancellation Reason'] || r['Churn Reason'],
        year: Number(y),
      });
    }
  }
  return out;
}

// --- Build CS lookup, prefer richest record per customer ---
function buildCsMap(records) {
  const map = new Map();
  for (const r of records) {
    const n = normalize(r.customer);
    if (!n) continue;
    const score = (r.category ? 1 : 0) + (r.notes ? 2 : 0) + (r.year || 0);
    const existing = map.get(n);
    if (!existing) { map.set(n, { rec: r, score }); continue; }
    if (score > existing.score) map.set(n, { rec: r, score });
  }
  return new Map([...map.entries()].map(([k, v]) => [k, v.rec]));
}

// --- Build the unified evidence blob per customer ---
function buildEvidenceBlob(profile, inferenceEntry, csRec) {
  const chunks = [];
  if (profile.churn_reason) chunks.push(`HubSpot: ${profile.churn_reason}`);
  if (inferenceEntry) {
    if (inferenceEntry.suggested_reason) chunks.push(`Inferred: ${inferenceEntry.suggested_reason}`);
    if (inferenceEntry.evidence_quote) chunks.push(`Evidence: ${inferenceEntry.evidence_quote}`);
    if (Array.isArray(inferenceEntry.signals)) chunks.push(`Signals: ${inferenceEntry.signals.join(' || ')}`);
  }
  if (csRec) {
    if (csRec.category) chunks.push(`CS-cat: ${csRec.category}`);
    if (csRec.notes) chunks.push(`CS-notes: ${csRec.notes}`);
  }
  return chunks.join(' | ');
}

// --- Main ---
const profiles = loadJSON(path.join(SNAP, 'customer_profiles.json'));
const inferences = loadJSON(path.join(SNAP, 'churn_inferences.json'));
const inferenceByAid = new Map(inferences.customers.map((c) => [c.allmoxy_customer_id, c]));
const csMap = buildCsMap(loadCsRecords());

// Identify customers in scope: anyone whose effective reason includes a parent we care about.
const parentReasons = new Set(Object.values(SUBPATTERNS).map((s) => s.parent));

const customerSubpatterns = {};  // aid -> array of subpattern ids
const summary = { total_tagged: 0, by_subpattern: {} };

for (const r of profiles.rows) {
  const aid = r.allmoxy_customer_id;
  if (!aid) continue;
  // Skip non-churned (still active or never paid)
  if (!((r.lifetime_subscription || 0) > 0 && (r.current_subscription_mrr || 0) <= 0)) continue;

  const inf = inferenceByAid.get(aid);
  // Determine effective reason set
  const reasons = [];
  if (r.churn_reason) for (const s of String(r.churn_reason).split(';')) reasons.push(s.trim());
  if (inf && inf.suggested_reason) for (const s of String(inf.suggested_reason).split(';')) reasons.push(s.trim());
  const reasonSet = new Set(reasons.filter(Boolean));
  // Only tag customers whose reasons touch one of the parent buckets we care about.
  if (![...reasonSet].some((x) => parentReasons.has(x))) continue;

  const blob = buildEvidenceBlob(r, inf, csMap.get(normalize(r.name)));
  const tags = [];
  for (const [id, def] of Object.entries(SUBPATTERNS)) {
    // Only check sub-patterns whose parent matches one of this customer's reasons.
    if (!reasonSet.has(def.parent)) continue;
    if (def.regex.some((rx) => rx.test(blob))) tags.push(id);
  }
  if (tags.length === 0) continue;
  customerSubpatterns[aid] = tags;
  summary.total_tagged++;
  for (const t of tags) summary.by_subpattern[t] = (summary.by_subpattern[t] || 0) + 1;
}

// Build subpattern_definitions object (drop the regex — not needed downstream).
const subpatternDefs = {};
for (const [id, def] of Object.entries(SUBPATTERNS)) {
  subpatternDefs[id] = { label: def.label, parent: def.parent, description: def.description };
}

const out = {
  tab: 'churn_subpatterns',
  fetchedAt: new Date().toISOString(),
  generatedBy: 'build_churn_subpatterns.mjs — keyword detection over customer_profiles + churn_inferences + Churn Details.xlsx',
  notes: 'Each customer can have multiple sub-pattern tags within their parent churn-reason cluster. Sub-patterns are not mutually exclusive.',
  subpattern_definitions: subpatternDefs,
  customer_subpatterns: customerSubpatterns,
};
fs.writeFileSync(path.join(SNAP, 'churn_subpatterns.json'), JSON.stringify(out, null, 2));

console.log(`Tagged ${summary.total_tagged} customers across ${Object.keys(summary.by_subpattern).length} sub-patterns`);
console.log('\nBy sub-pattern:');
for (const [id, n] of Object.entries(summary.by_subpattern).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${SUBPATTERNS[id].label}  (${id})`);
}
