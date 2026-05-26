#!/usr/bin/env node
// Pilot churn corpus assembled from Claude HubSpot MCP for the top 5 churned
// customers by lifetime $. Produces the same JSON shape as build_churn_corpus.mjs.
// Run from repo root: node _etl_scripts/build_churn_corpus_pilot.mjs
//
// To extend to the full 291-customer corpus, fix the HubSpot Private App auth
// and run build_churn_corpus.mjs instead — MCP isn't practical at that scale.

import fs from 'node:fs';
import path from 'node:path';

const PORTAL_ID = '4910812';
const SNAP = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/public/snapshots';

// Customer metadata — top 5 by lifetime subscription $
const META = [
  { aid: 302, name: 'Artisan Cabinet',                   hsid: '6753435921',  lt: 132770.69, last: '2023-05-15', pay: null, reason: null, seg: null },
  { aid: 293, name: 'B&B Door Co.',                      hsid: '5094378641',  lt: 81569.00,  last: '2024-12-16', pay: null, reason: null, seg: null },
  { aid: 15,  name: 'Mid Michigan Wood',                 hsid: '1128632982',  lt: 70269.00,  last: '2025-12-04', pay: null, reason: null, seg: null },
  { aid: 172, name: 'Kiwi Closets - ProComm Closets LLC',hsid: '10807972277', lt: 47302.00,  last: '2026-02-12', pay: 'Cancelled', reason: 'Business Model Change', seg: null },
  { aid: 171, name: 'Homewood Creations',                hsid: '1172634991',  lt: 44407.00,  last: '2023-03-05', pay: 'Cancelled', reason: null, seg: null },
];

// Raw engagement records — minimal fields needed for the mappers.
// Bodies are body_preview (clean text, ~200 char excerpts). Source links deep into HubSpot.
const RAW = {
  '6753435921': {
    notes: JSON.parse(`[
      {"id":"34681273668","properties":{"hs_timestamp":"2023-05-11T16:13:37.630Z","hs_body_preview":"@Samantha Alexander This is it"}},
      {"id":"34681896805","properties":{"hs_timestamp":"2023-05-11T16:02:26.516Z","hs_body_preview":"$699 USD/Month. 12-Month Contract. Void old contract. $1099/month Going with the original agreement where the price goes up $300 per million. Integration 50-100 hours Closet pro and Microvellumn reference of someone exporting out of microvellumn as well as people who did not like vesta"}},
      {"id":"27253519518","properties":{"hs_timestamp":"2022-10-27T17:08:55.757Z","hs_body_preview":""}},
      {"id":"25775691799","properties":{"hs_timestamp":"2022-09-17T17:55:58.916Z","hs_body_preview":"@Sarah Pierce @Beau Lewis Any data her on this account with Jason at Artisan I should know?"}},
      {"id":"16529754174","properties":{"hs_timestamp":"2021-10-18T18:46:03.420Z","hs_body_preview":"Artisan is no longer using Cut Rite, therefore they will no longer be working with Payton. They are no using Microvellum and have been paired with Jake at Luminary."}},
      {"id":"16171743340","properties":{"hs_timestamp":"2021-10-01T20:45:56.346Z","hs_body_preview":"Sarah Pierce This customer is signed up, set up on a time with payton, and ready to go!"}},
      {"id":"16171778650","properties":{"hs_timestamp":"2021-10-01T20:42:24.751Z","hs_body_preview":"Beau Lewis Please Charge this customer an additional $449 ASAP."}}
    ]`),
    emails: JSON.parse(`[
      {"id":"34681966467","properties":{"hs_timestamp":"2023-05-11T16:20:10.415Z","hs_email_subject":"Artisan Custom Interiors - Allmoxy Onboarding","hs_email_direction":"EMAIL"}},
      {"id":"19799888187","properties":{"hs_timestamp":"2022-03-03T20:03:51Z","hs_email_subject":"Re: Juan's log in info","hs_email_direction":"INCOMING_EMAIL"}},
      {"id":"19799950888","properties":{"hs_timestamp":"2022-03-03T19:58:22Z","hs_email_subject":"Re: Juan's log in info","hs_email_direction":"INCOMING_EMAIL"}},
      {"id":"19799239337","properties":{"hs_timestamp":"2022-03-03T19:29:33Z","hs_email_subject":"Re: Juan's log in info","hs_email_direction":"EMAIL"}},
      {"id":"19797728528","properties":{"hs_timestamp":"2022-03-03T18:55:19Z","hs_email_subject":"Re: Juan's log in info","hs_email_direction":"INCOMING_EMAIL"}},
      {"id":"19791778121","properties":{"hs_timestamp":"2022-03-03T17:00:52Z","hs_email_subject":"Re: Add Juan and remove Jake","hs_email_direction":"INCOMING_EMAIL"}},
      {"id":"19791759426","properties":{"hs_timestamp":"2022-03-03T16:58:35Z","hs_email_subject":"Juan's log in info","hs_email_direction":"EMAIL"}},
      {"id":"19793116527","properties":{"hs_timestamp":"2022-03-03T16:42:38Z","hs_email_subject":"Add Juan and remove Jake","hs_email_direction":"EMAIL"}},
      {"id":"19757446434","properties":{"hs_timestamp":"2022-03-02T16:03:28Z","hs_email_subject":"Re: artisan price sheet","hs_email_direction":"EMAIL"}},
      {"id":"19756632101","properties":{"hs_timestamp":"2022-03-02T15:48:00Z","hs_email_subject":"Fwd: artisan price sheet","hs_email_direction":"EMAIL"}},
      {"id":"19756737377","properties":{"hs_timestamp":"2022-03-02T15:45:38Z","hs_email_subject":"Re: artisan price sheet","hs_email_direction":"EMAIL"}},
      {"id":"19753008487","properties":{"hs_timestamp":"2022-03-02T14:16:03Z","hs_email_subject":"Re: artisan price sheet","hs_email_direction":"INCOMING_EMAIL"}},
      {"id":"19753043605","properties":{"hs_timestamp":"2022-03-02T14:15:41Z","hs_email_subject":"Re: artisan price sheet","hs_email_direction":"INCOMING_EMAIL"}},
      {"id":"19724943704","properties":{"hs_timestamp":"2022-03-01T16:40:33Z","hs_email_subject":"Re: artisan price sheet","hs_email_direction":"EMAIL"}},
      {"id":"19725211528","properties":{"hs_timestamp":"2022-03-01T16:38:40Z","hs_email_subject":"Re: artisan price sheet","hs_email_direction":"INCOMING_EMAIL"}}
    ]`),
    calls: JSON.parse(`[
      {"id":"19617256540","properties":{"hs_timestamp":"2022-02-24T20:27:23.189Z","hs_call_title":"Call with jason fiuemfreddo"}},
      {"id":"19505542295","properties":{"hs_timestamp":"2022-02-21T16:00:38.134Z","hs_call_title":"Call with Artisan Custom Interiors","hs_call_duration":"22000","hs_call_direction":"OUTBOUND"}},
      {"id":"19463425325","properties":{"hs_timestamp":"2022-02-18T18:31:09.646Z","hs_call_title":"Call with Artisan Custom Interiors","hs_call_duration":"39000","hs_call_direction":"OUTBOUND"}},
      {"id":"19463340866","properties":{"hs_timestamp":"2022-02-18T18:30:09.818Z","hs_call_title":"Call with jason fiuemfreddo","hs_call_duration":"13000","hs_call_direction":"OUTBOUND"}},
      {"id":"16210891433","properties":{"hs_timestamp":"2021-10-04T20:32:32.844Z","hs_call_title":"Call with Jason Fiumefreddo","hs_call_body":"Left a voicemail with Janet (no Jason option). I'll follow up with a voicemail!"}}
    ]`),
    tasks: JSON.parse(`[
      {"id":"34681300059","properties":{"hs_timestamp":"2023-05-22T14:00:00Z","hs_task_subject":"Follow up on Artisan Custom Interiors","hs_task_body":"Regarding email: Artisan Custom Interiors - Allmoxy Onboarding, sent on Thursday, May 11, 2023 10:20 AM","hs_task_status":"COMPLETED"}},
      {"id":"16483602554","properties":{"hs_timestamp":"2022-09-29T14:00:00Z","hs_task_subject":"Contract Renewal","hs_task_body":"Broc Hill - Please reach out to the customer, follow these steps to provide the highest percentage of contract renewal and contract value take place. 1. Build Rapport 2. Evaluate Current Situation 3. Allmoxy Future-pace (Add Value) 4. Send / Get Signed New Agreement","hs_task_status":"COMPLETED"}},
      {"id":"16843868189","properties":{"hs_timestamp":"2021-10-31T06:00:29.330Z","hs_task_subject":"Credit Card Charge Failing","hs_task_body":"Artisan Custom Interiors's credit card is failing. Their Site will get shut off soon. An email has been sent, but will you reach out to make sure they know what is happening?","hs_task_status":"COMPLETED"}},
      {"id":"16210766184","properties":{"hs_timestamp":"2021-10-07T14:00:00Z","hs_task_subject":"Follow up with Artisan Custom Interiors","hs_task_body":"Regarding call logged on Monday, October 4, 2021 4:35 PM","hs_task_status":"COMPLETED"}},
      {"id":"16171362569","properties":{"hs_timestamp":"2021-10-01T20:46:31.050Z","hs_task_subject":"Welcome call to intro success team to Artisan Custom Interiors","hs_task_status":"COMPLETED"}}
    ]`),
    tickets: JSON.parse(`[]`),
  },
  '5094378641': {
    notes: JSON.parse(`[
      {"id":"108681469548","properties":{"hs_timestamp":"2026-04-24T20:42:06.169Z","hs_body_preview":"@Beau Lewis I looked into this and they signed an agreement on 12/16/25 for 12 months. But they mailed a check, did you receive it?"}},
      {"id":"106735100039","properties":{"hs_timestamp":"2026-03-20T21:48:09.269Z","hs_body_preview":"Transition note 3/20/26 These guys are great! Small family-run operation out of MI. Cam is the main POC and usually reaches out to either report bugs or ask questions about once a month. Door and Drawer Box manufacturers. Very well adopted to Allmoxy. Recently renewed for 1 year"}},
      {"id":"99314117686","properties":{"hs_timestamp":"2025-12-19T17:40:01.239Z","hs_body_preview":"Renewal Lifecycle Playbook: Yes, in contract. Expansion revenue captured. 5% increase from last year. 12 months. CS Health Pulse Green (advocate, churn would be shocking)."}},
      {"id":"97972361481","properties":{"hs_timestamp":"2025-12-04T15:54:37.148Z","hs_body_preview":"Renewal proposal 12/4/25. Current rate: $990/month (paid upfront last year $11,880). Dec 2024-Dec 2025 verified revenue over 1.5M. Customers within 1-2M revenue typically pay ~$1600/month. Since Mid Michigan is legacy, more modest increase. Proposal: 12-month at $1,060/month OR 18-month at $1,045/month."}},
      {"id":"74396213307","properties":{"hs_timestamp":"2025-03-06T20:00:52.820Z","hs_body_preview":"Meeting with Cam & Sarah 3/6/25. Cam wants to filter orders by specific supplies. Doesn't like Customer Product History or Sales by Product Report. Suggestions: hardware dropdown, tagging orders, supplies as products."}}
    ]`),
    emails: JSON.parse(`[
      {"id":"109785288467","properties":{"hs_timestamp":"2026-05-19T15:19:44.798Z","hs_email_subject":"Re: Allmoxy Annual Renewal","hs_email_direction":"EMAIL"}},
      {"id":"109620344866","properties":{"hs_timestamp":"2026-05-14T20:09:03.955Z","hs_email_subject":"Re: Allmoxy Annual Renewal","hs_email_direction":"EMAIL"}},
      {"id":"109292095112","properties":{"hs_timestamp":"2026-05-07T16:22:55.454Z","hs_email_subject":"Re: Allmoxy Annual Renewal","hs_email_direction":"EMAIL"}},
      {"id":"109291700761","properties":{"hs_timestamp":"2026-05-07T16:14:20Z","hs_email_subject":"Re: Allmoxy Annual Renewal","hs_email_direction":"INCOMING_EMAIL"}},
      {"id":"109288263064","properties":{"hs_timestamp":"2026-05-07T16:12:26.070Z","hs_email_subject":"Re: Allmoxy Annual Renewal","hs_email_direction":"EMAIL"}},
      {"id":"109202153267","properties":{"hs_timestamp":"2026-05-05T21:51:00.072Z","hs_email_subject":"Allmoxy Annual Renewal","hs_email_direction":"EMAIL"}},
      {"id":"108682148151","properties":{"hs_timestamp":"2026-04-24T22:20:30.375Z","hs_email_subject":"Allmoxy Annual Renewal ","hs_email_direction":"EMAIL"}},
      {"id":"108458221397","properties":{"hs_timestamp":"2026-04-23T15:23:39.090Z","hs_email_subject":"Your New Allmoxy Customer Success Manager - Let's Connect!","hs_email_direction":"EMAIL"}},
      {"id":"107370739373","properties":{"hs_timestamp":"2026-04-02T17:01:36.206Z","hs_email_subject":"Re: Fw: CV Export Feature Question","hs_email_direction":"EMAIL"}},
      {"id":"107374138794","properties":{"hs_timestamp":"2026-04-02T14:20:35Z","hs_email_subject":"Fw: CV Export Feature Question","hs_email_direction":"INCOMING_EMAIL"}}
    ]`),
    calls: JSON.parse(`[
      {"id":"80629830958","properties":{"hs_timestamp":"2025-06-03T14:03:45Z","hs_call_title":"Meeting with Rose Miller from B&B Door Co.","hs_call_duration":"642000"}},
      {"id":"65354220580","properties":{"hs_timestamp":"2024-11-25T19:00:22Z","hs_call_title":"BB Door Company Allmoxy Contract Renewal","hs_call_duration":"1718000"}},
      {"id":"56811239832","properties":{"hs_timestamp":"2024-07-23T19:02:23Z","hs_call_title":"Lexi Williams, B&B Door Co.- Allmoxy Scope / Integrations","hs_call_duration":"3726000"}},
      {"id":"51413278597","properties":{"hs_timestamp":"2024-04-22T14:30:37Z","hs_call_title":"B&B Door Co. Lexi Williams","hs_call_duration":"2208000"}},
      {"id":"44897819483","properties":{"hs_timestamp":"2023-12-28T17:00:43Z","hs_call_title":"Lexi Williams and Gavin Flitton","hs_call_duration":"877000"}},
      {"id":"44533906303","properties":{"hs_timestamp":"2023-12-19T20:14:15Z","hs_call_title":"B&B Door Co. Allmoxy Renewal","hs_call_duration":"3383000"}}
    ]`),
    tasks: JSON.parse(`[
      {"id":"108457798034","properties":{"hs_timestamp":"2026-04-28T14:00:00Z","hs_task_subject":"Follow up with Amy Walley","hs_task_status":"NOT_STARTED"}},
      {"id":"65351866233","properties":{"hs_timestamp":"2024-12-10T15:00:00Z","hs_task_subject":"Follow up on B&B's revenue- contact Lexi to solidify agreement for 2025","hs_task_status":"NOT_STARTED"}},
      {"id":"29541497375","properties":{"hs_timestamp":"2023-12-12T17:00:00Z","hs_task_subject":"B&B Custom Doors (Paid Upfront)- Contract Renewal (start sequence)","hs_task_body":"B&B Custom Doors (Paid Upfront) - Renewal is due","hs_task_status":"COMPLETED"}},
      {"id":"10933423385","properties":{"hs_timestamp":"2021-02-05T07:02:24.366Z","hs_task_subject":"B&b Door Just went inactive for 7 days. Look into it!","hs_task_body":"Contact Company name Just went inactive for 7 days. Look into it!","hs_task_status":"COMPLETED"}}
    ]`),
    tickets: JSON.parse(`[
      {"id":"2500573260","properties":{"createdate":"2024-03-18T18:12:57.468Z","subject":"Bot-Created Ticket","content":"84780","hs_pipeline_stage":"10611513"}},
      {"id":"2479148805","properties":{"createdate":"2024-03-13T18:51:11.299Z","subject":"Bot-Created Ticket","content":"Order number 84340 was the latest example. Also, when something is typed into the description under 'Other costs' it doesn't list it under description. Instead, we have to write something in the notes section on the sidebar for it to even show on the invoice","hs_pipeline_stage":"10611513"}},
      {"id":"1558244101","properties":{"createdate":"2023-04-14T17:37:17.983Z","subject":"New pricing for doors and drawer fronts","hs_pipeline_stage":"28203120"}},
      {"id":"1317043329","properties":{"createdate":"2022-12-13T16:35:04.419Z","subject":"Investigate - Find first: No matching PartList records found Error","hs_pipeline_stage":"10611514"}},
      {"id":"1265417045","properties":{"createdate":"2022-11-15T17:04:31.205Z","subject":"B&B Door Co.","hs_pipeline_stage":"28203121"}}
    ]`),
  },
  '1128632982': {
    notes: JSON.parse(`[
      {"id":"99314117686","properties":{"hs_timestamp":"2025-12-19T17:40:01.239Z","hs_body_preview":"Renewal Lifecycle Playbook. Yes, in contract. Expansion revenue captured. 5% increase from last year. 12 month contract. Launch status Yes. CS Health Pulse Green (this customer is in good/great standing and would advocate for Allmoxy - churn would be shocking)."}},
      {"id":"97972361481","properties":{"hs_timestamp":"2025-12-04T15:54:37.148Z","hs_body_preview":"Renewal proposal 12/4/25. Current rate $990/month (paid upfront last year $11,880). Dec 2024-Dec 2025 verified revenue over 1.5M. Typically customers within 1-2M revenue range pay ~$1600/month. Legacy customer modest increase. 12-month at $1060 or 18-month at $1045."}},
      {"id":"64160463753","properties":{"hs_timestamp":"2024-11-08T17:38:41.188Z","hs_body_preview":"Paid up front for the year on 11/7 for 12/10/2024 to 12/10/2025. ($11,880)"}},
      {"id":"63627858524","properties":{"hs_timestamp":"2024-10-31T19:15:32.594Z","hs_body_preview":"Mid Michigan Wood contract renewal 10/31/24 with Bev and Jim. How are things going? Going really smooth. Been nice to work with CS to get the label situation smoothed out. Biggest value add: keeping track of orders, order entry. Pain points: label issue persists, email confirmations don't have reply address."}},
      {"id":"42368051871","properties":{"hs_timestamp":"2023-11-07T21:03:59.921Z","hs_body_preview":"Renewal 2023. Beverly and Jim are owners. Been with Allmoxy since 2019. They LOVE Allmoxy. Would not be around without it. What we can do better: Bev and Jim aren't super tech savvy, hard to make changes to products."}}
    ]`),
    emails: JSON.parse(`[
      {"id":"109558087036","properties":{"hs_timestamp":"2026-05-13T18:58:49.170Z","hs_email_subject":"Re: Batch","hs_email_direction":"EMAIL"}},
      {"id":"109561216553","properties":{"hs_timestamp":"2026-05-13T18:52:51.341Z","hs_email_subject":"Re: Batch","hs_email_direction":"EMAIL"}},
      {"id":"109333316504","properties":{"hs_timestamp":"2026-05-08T13:15:31Z","hs_email_subject":"Attribute by Cust","hs_email_direction":"INCOMING_EMAIL"}}
    ]`),
    calls: JSON.parse(`[
      {"id":"85998412873","properties":{"hs_timestamp":"2025-08-13T17:00:42Z","hs_call_title":"How to Build a Smarter Allmoxy Catalog: Structure, Strategy, and What to Avoid","hs_call_duration":"3632000"}},
      {"id":"83469997965","properties":{"hs_timestamp":"2025-07-16T17:00:12Z","hs_call_title":"Adapting Fast: How to Build a Catalog That Keeps Up With Your Business","hs_call_duration":"1302000"}},
      {"id":"63601385292","properties":{"hs_timestamp":"2024-10-31T18:15:47Z","hs_call_title":"Mid Michigan Wood Specialties Allmoxy Contract Renewal","hs_call_duration":"897000"}}
    ]`),
    tasks: JSON.parse(`[
      {"id":"40977548108","properties":{"hs_timestamp":"2023-10-11T15:00:00Z","hs_task_subject":"Credit Card Charge Failing","hs_task_body":"Mid Michigan Wood's credit card is failing. Their Site will get shut off soon. An email has been sent, but will you reach out to make sure they know what is happening?","hs_task_status":"COMPLETED"}},
      {"id":"42365125922","properties":{"hs_timestamp":"2023-11-13T17:00:00Z","hs_task_subject":"Update pricing in installer to $1100 per month","hs_task_body":"Negotiated with Beverly that this agreement will go into effect in December.","hs_task_status":"COMPLETED"}}
    ]`),
    tickets: JSON.parse(`[
      {"id":"28969608988","properties":{"createdate":"2025-08-26T11:06:34Z","subject":"Re: Allmoxy Services Invoice #5436 from Allmoxy","content":"Curious why I'm receiving a charge from you guys?","hs_pipeline_stage":"10611514"}},
      {"id":"22317107640","properties":{"createdate":"2025-04-11T17:31:02Z","subject":"Tax","content":"Hello, Since the new tax update you guys did, when we go to export invoices into QuickBooks through Rightworks transaction pro 8, every invoice gets transferred without tax. Is there something we need to change on our end? -Cam","hs_pipeline_stage":"10611514"}},
      {"id":"2987882921","properties":{"createdate":"2024-07-19T22:58:30Z","subject":"Fwd: Allmoxy question","content":"From Jim midmichiganwood: Hey Josh, More often than not I get this screen (attached) when navigating from place to place in Allmoxy. Can you tell me if this is an issue with my computer or do you have an idea of what I can do to keep this from happening? Thanks, Jim","hs_pipeline_stage":"10611514"}}
    ]`),
  },
  '10807972277': {
    notes: JSON.parse(`[
      {"id":"104086212466","properties":{"hs_timestamp":"2026-02-12T18:30:39.159Z","hs_body_preview":"CHURN PLAYBOOK: They are moving into a different industry (hospitality) out of necessity. They had hoped their new customers would want to use Allmoxy, but there wasn't any appetite. They go to the sites and give quotes based on what they see. They appreciate our team and personally love our platform. It just doesn't make sense to keep Allmoxy where they are headed. Business Model Change."}},
      {"id":"100978751920","properties":{"hs_timestamp":"2026-01-12T18:37:17.006Z","hs_body_preview":"CHURN RISK PLAYBOOK: Health pulse Red. Joel emailed saying they will not be renewing their contract next month. Monthly subscription $778. SMB. Customer since 04/01/2020. Legacy account. We made a plan last year to have meetings to discuss Allmoxy strategy with their new hospitality market. Set several meetings but he always rescheduled because he was too busy. Pivoting to new customer base that doesn't see benefit of Allmoxy."}},
      {"id":"89269994916","properties":{"hs_timestamp":"2025-09-23T15:51:30.720Z","hs_body_preview":"Renewal Lifecycle Playbook: subscription amount high for customers verified order amount, new features required for full value perception/adoption. Joel has had issues with validations, too much work that needs to be done and doesn't particularly want to pay us. Really wants the dynamic attributes. New business opportunity with hotels, his main focus is on that. Tried to meet 4-5 times but kept rescheduling. CS Health Pulse Red."}},
      {"id":"69216920670","properties":{"hs_timestamp":"2025-01-15T20:34:23.972Z","hs_body_preview":"Renewal Call with Joel 1/15/25. For the most part in back end Allmoxy was not working with their shop with inventory tracking. Only wants to keep the online storefront. Doesn't like spending $778 for that. Wasn't working with inventory side. They shifted use case and have been approached by hospitality projects - bigger projects, very promising. He wanted less than $778 but I let him know that's the best we can do."}},
      {"id":"65793334588","properties":{"hs_timestamp":"2024-12-02T22:54:11.054Z","hs_body_preview":"Renewal Meeting 2024 with Kenzi, Joel, Josh. They have a huge business opportunity coming down the pipeline and are unsure if they want to utilize Allmoxy. Allmoxy is essentially going to be an online store front for them. Made decision to get rid of all cabinets, keep closets."}}
    ]`),
    emails: JSON.parse(`[
      {"id":"101090051768","properties":{"hs_timestamp":"2026-01-13T23:12:19.649Z","hs_email_subject":"Re: Allmoxy Designer Feature Update","hs_email_direction":"EMAIL"}},
      {"id":"100950180887","properties":{"hs_timestamp":"2026-01-12T21:38:10.129Z","hs_email_subject":"Re: Allmoxy Designer Feature Update","hs_email_direction":"EMAIL"}}
    ]`),
    calls: JSON.parse(`[
      {"id":"65791767409","properties":{"hs_timestamp":"2024-12-02T22:15:37Z","hs_call_title":"Allmoxy Savings Agreement Renewal | ProComm Closets LLC Joel","hs_call_duration":"1264000"}},
      {"id":"43902346862","properties":{"hs_timestamp":"2023-12-08T19:44:10Z","hs_call_title":"Allmoxy Savings Agreement Renewal | ProComm Closets LLC Joel","hs_call_duration":"1308000"}}
    ]`),
    tasks: JSON.parse(`[
      {"id":"104087759424","properties":{"hs_timestamp":"2027-02-12T15:00:00Z","hs_task_subject":"Churned customer re-engagement consideration","hs_task_body":"See Churn playbook and retention notes for full context. For more information reach out to the former assigned CSM.","hs_task_status":"NOT_STARTED"}},
      {"id":"10684757483","properties":{"hs_timestamp":"2021-01-21T07:02:25.348Z","hs_task_subject":"ProComm Builders LLC, DBA Kiwi Closets Just went inactive for 7 days. Look into it!","hs_task_status":"COMPLETED"}}
    ]`),
    tickets: JSON.parse(`[
      {"id":"164595823","properties":{"createdate":"2020-07-22T14:09:38.871Z","subject":"DEVMRP - Include Part Number from Supplies on the Resource Allocation tab","content":"Joel from Kiwi Cabinets has suggested that the part number from his supplies pull to the resource allocation page.","hs_pipeline_stage":"690248"}},
      {"id":"106705735","properties":{"createdate":"2020-03-19T14:59:32.863Z","subject":"Kiwi Closets - Adds","hs_pipeline_stage":"690248"}},
      {"id":"39163233","properties":{"createdate":"2019-08-06T15:00:12.966Z","subject":"Kiwi Closets - 9 Closet Products MRP","hs_pipeline_stage":"690281"}}
    ]`),
  },
  '1172634991': {
    notes: JSON.parse(`[
      {"id":"32096602762","properties":{"hs_timestamp":"2023-03-05T22:00:51.988Z","hs_body_preview":"@Mekenzi Falslev This account cancelled..."}}
    ]`),
    emails: JSON.parse(`[]`),
    calls: JSON.parse(`[]`),
    tasks: JSON.parse(`[
      {"id":"97989830937","properties":{"hs_timestamp":"2026-12-04T15:00:00Z","hs_task_subject":"Churned customer re-engagement consideration","hs_task_body":"See Churn playbook and retention notes for full context. For more information reach out to the former assigned CSM.","hs_task_status":"NOT_STARTED"}}
    ]`),
    tickets: JSON.parse(`[]`),
  },
};

function mapNote(n) {
  return {
    type: 'note',
    ts: n.properties?.hs_timestamp ?? null,
    title: null,
    body: n.properties?.hs_body_preview ?? '',
    hubspot_id: n.id,
    source_url: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-46/${n.id}`,
  };
}
function mapEmail(e) {
  return {
    type: 'email',
    ts: e.properties?.hs_timestamp ?? null,
    title: e.properties?.hs_email_subject ?? null,
    body: e.properties?.hs_body_preview ?? '',
    direction: e.properties?.hs_email_direction ?? null,
    hubspot_id: e.id,
    source_url: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-49/${e.id}`,
  };
}
function mapCall(c) {
  return {
    type: 'call',
    ts: c.properties?.hs_timestamp ?? null,
    title: c.properties?.hs_call_title ?? null,
    body: c.properties?.hs_call_body ?? c.properties?.hs_body_preview ?? '',
    direction: c.properties?.hs_call_direction ?? null,
    duration_ms: c.properties?.hs_call_duration ? Number(c.properties.hs_call_duration) : null,
    hubspot_id: c.id,
    source_url: `https://app.hubspot.com/calls/${PORTAL_ID}/review/${c.id}`,
  };
}
function mapTask(t) {
  return {
    type: 'task',
    ts: t.properties?.hs_timestamp ?? null,
    title: t.properties?.hs_task_subject ?? null,
    body: t.properties?.hs_task_body ?? '',
    status: t.properties?.hs_task_status ?? null,
    hubspot_id: t.id,
    source_url: `https://app.hubspot.com/tasks/${PORTAL_ID}/view/all/task/${t.id}`,
  };
}
function mapTicket(t) {
  return {
    type: 'ticket',
    ts: t.properties?.createdate ?? null,
    title: t.properties?.subject ?? null,
    body: t.properties?.content ?? '',
    pipeline_stage: t.properties?.hs_pipeline_stage ?? null,
    hubspot_id: t.id,
    source_url: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-5/${t.id}`,
  };
}

const customers = [];
let totalEngagements = 0;
for (const m of META) {
  const r = RAW[m.hsid] ?? {};
  const engagements = [];
  for (const x of r.notes ?? []) engagements.push(mapNote(x));
  for (const x of r.emails ?? []) engagements.push(mapEmail(x));
  for (const x of r.calls ?? []) engagements.push(mapCall(x));
  for (const x of r.tasks ?? []) engagements.push(mapTask(x));
  for (const x of r.tickets ?? []) engagements.push(mapTicket(x));
  engagements.sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));

  const counts = { note: 0, email: 0, call: 0, task: 0, ticket: 0 };
  for (const e of engagements) counts[e.type] = (counts[e.type] || 0) + 1;

  customers.push({
    allmoxy_customer_id: m.aid,
    name: m.name,
    hubspot_company_id: Number(m.hsid),
    lifetime_subscription: m.lt,
    last_payment_date: m.last,
    pay_status: m.pay,
    churn_reason: m.reason,
    primary_segment: m.seg,
    engagement_counts_by_type: counts,
    engagements,
  });
  totalEngagements += engagements.length;
}

customers.sort((a, b) => b.lifetime_subscription - a.lifetime_subscription);

const out = {
  tab: 'churn_corpus',
  fetchedAt: new Date().toISOString(),
  generatedBy: 'build_churn_corpus_pilot.mjs (top-5 pilot via Claude HubSpot MCP)',
  customer_count: customers.length,
  engagement_count: totalEngagements,
  customers,
  notes:
    'Pilot corpus pulled via the Claude HubSpot MCP connector for the 5 highest-lifetime-$ churned customers. ' +
    'Bodies are body_preview excerpts (~200 char); follow the source_url to read full content in HubSpot. ' +
    'To extend to the full 291-customer corpus, fix the HubSpot Private App auth and run build_churn_corpus.mjs.',
};

const outputPath = path.join(SNAP, 'churn_corpus.json');
fs.writeFileSync(outputPath, JSON.stringify(out));
const sz = (fs.statSync(outputPath).size / 1024).toFixed(1);
console.log(`Wrote churn_corpus.json (${sz} KB) — ${customers.length} customers · ${totalEngagements} engagements`);
