/**
 * Every WhatsApp message the app sends, as a Meta template ready to approve (#112).
 *
 * Within 24 hours of someone's last message the app sends its own words; after that WhatsApp delivers
 * only approved templates, so each message has one here, with its variables in the same order the code
 * passes them. Written to Meta's rules:
 *  - a variable never starts or ends the body, and two never sit side by side (a word or mark between);
 *  - few variables for the length, and each has a sample value (Meta refuses a template without them);
 *  - Utility only: these are updates about work under way, never Marketing;
 *  - the company is a variable of the header, so the same pack works for any company set up on the app;
 *  - quick-reply buttons only where the person answers; their replies come back to the app.
 * A test checks every outbound message in the code names one of these, so none is left out.
 */

export type WaCategory = 'UTILITY' | 'AUTHENTICATION';
export interface WaTemplate {
  /** The template's name at Meta: snake_case, unique per business account. */
  name: string;
  category: WaCategory;
  language: string;
  /** What makes the app send it, for the screen and the document. */
  trigger: string;
  /** Who gets it. */
  audience: 'driver' | 'customer' | 'approver' | 'finance' | 'anyone';
  /** Header text with the company as {{1}}. */
  header: string;
  body: string;
  footer?: string;
  buttons?: string[];
  /** One sample per body variable, in order ({{1}} first). */
  samples: string[];
  /** For a company's own message template that names this one: the placeholders that give each variable. */
  placeholders?: string[];
}

const HEADER = 'Update from {{1}}';
export const HEADER_SAMPLE = 'Acme Haulage';
const FOOTER = 'Reply here if you have a question.';
const utility = (t: Omit<WaTemplate, 'category' | 'language' | 'header' | 'footer'> & { footer?: string }): WaTemplate => ({ category: 'UTILITY', language: 'en', header: HEADER, footer: FOOTER, ...t });

export const WA_TEMPLATES = [
  utility({ name: 'trip_assigned', audience: 'driver', trigger: 'A trip is created for the driver, or the driver of a trip changes.',
    body: 'You have a new trip, {{1}}: truck {{2}} for {{3}}, {{4}}. It starts {{5}}; the office will confirm before you leave.',
    samples: ['TRIP/26/0012', 'ALC 4821', 'Zambezi Energy Ltd', 'Dar es Salaam port to Lusaka fuel depot', '6 Nov, 06:00'] }),
  utility({ name: 'trip_dispatched', audience: 'driver', trigger: 'The trip is dispatched.',
    body: 'You are on your way with trip {{1}}. Head to {{2}} for loading and offload at {{3}}. Truck {{4}}, fuel in the tank {{5}}, cash with you {{6}}. Drive safely.',
    samples: ['TRIP/26/0012', 'Dar es Salaam port', 'Lusaka fuel depot', 'ALC 4821 · TAC 7821', '900 L', '5,340 ZMW'] }),
  utility({ name: 'money_issued', audience: 'driver', trigger: 'Finance issues fuel or pays an advance for the trip.',
    body: 'For trip {{1}}: {{2}}, {{3}}. Reference {{4}}. Keep the receipts for what you spend.',
    samples: ['TRIP/26/0012', 'fuel issued', '900 L for ALC 4821 by own depot fuel', 'DEPOT-0001'] }),
  utility({ name: 'arrived_send_document', audience: 'driver', trigger: 'The truck reaches its loading or offloading place.',
    body: 'You have reached {{1}} on trip {{2}}. Please send {{3}} as a photo in this chat.',
    buttons: ['Send it now'], samples: ['Dar es Salaam port', 'TRIP/26/0012', 'the loading invoice once the tanker is filled and sealed'] }),
  utility({ name: 'document_received', audience: 'driver', trigger: 'The driver sends a document or receipt.',
    body: 'We got your {{1}}. {{2}} will check it and tell you here.',
    samples: ['loading invoice TPA-INV-55120', 'Operations'] }),
  utility({ name: 'document_returned', audience: 'driver', trigger: 'Operations sends a document back to be sent again.',
    body: 'Please send your {{1}} again. The reason: {{2}}. Send the new photo in this chat.',
    buttons: ['Send it now'], samples: ['loading invoice', 'the photo is blurred'] }),
  utility({ name: 'document_reminder', audience: 'driver', trigger: 'Operations reminds the driver about a document.',
    body: 'A reminder about trip {{1}}: Operations is waiting for your {{2}}. Send it as a photo in this chat.',
    buttons: ['Send it now'], samples: ['TRIP/26/0012', 'delivery note'] }),
  utility({ name: 'loading_confirmed', audience: 'driver', trigger: 'Operations confirms the loading.',
    body: 'Loading confirmed on trip {{1}}: {{2}}. Drive safely to {{3}} and send the delivery note there.',
    samples: ['TRIP/26/0012', '38,000 L at 20 °C of diesel 50 ppm', 'Lusaka fuel depot'] }),
  utility({ name: 'delivery_confirmed', audience: 'driver', trigger: 'Operations confirms the delivery.',
    body: 'Delivery confirmed on trip {{1}}: {{2}}. Thank you.',
    samples: ['TRIP/26/0012', '37,722 L at 20 °C, delivery note ZE-DN-3381'] }),
  utility({ name: 'shortage_decided', audience: 'driver', trigger: 'Finance charges or waives a shortage.',
    body: 'About the shortage on trip {{1}}: {{2}}. Ask the office if anything is unclear.',
    samples: ['TRIP/26/0012', 'no charge'] }),
  utility({ name: 'expense_decided', audience: 'driver', trigger: 'Finance approves or rejects a receipt.',
    body: 'Your expense {{1}} was {{2}}: {{3}}. Ask the office if anything is unclear.',
    samples: ['Road and border 450 ZMW', 'approved', 'it is off your balance'] }),
  utility({ name: 'trip_closed', audience: 'driver', trigger: 'The trip ends, its load moves to another truck, or it is written off.',
    body: 'Trip {{1}} is closed: {{2}}. Thank you for the trip.',
    samples: ['TRIP/26/0012', 'truck parked at Lusaka fuel depot with 40 L'] }),
  utility({ name: 'trip_stopped', audience: 'driver', trigger: 'The trip is cancelled or stopped before loading.',
    body: 'Trip {{1}} is {{2}}: {{3}}. The office will tell you what comes next.',
    samples: ['TRIP/26/0012', 'stopped', 'the customer cancelled; park the truck at Lusaka fuel depot'] }),
  utility({ name: 'load_return', audience: 'driver', trigger: 'A load that cannot be delivered is to go back.',
    body: 'On trip {{1}} the load cannot be delivered: {{2}}. Please take it back to {{3}} and tell us here.',
    samples: ['TRIP/26/0012', 'the depot is closed for repairs', 'Dar es Salaam port'] }),
  utility({ name: 'settlement_posted', audience: 'driver', trigger: 'Finance posts the driver\'s statement.',
    body: 'Your statement {{1}} is ready: {{2}}. Open the driver app to see every line.',
    samples: ['SET/26/0004', 'you returned 4,890 ZMW and nothing carries forward'] }),
  utility({ name: 'office_message', audience: 'anyone', trigger: 'Someone at the office writes to a driver or customer in the app.',
    body: 'A message from {{1}} at the office: "{{2}}". Reply here to answer.',
    samples: ['Olivia', 'Please call me when you reach the border'] }),
  utility({ name: 'nomination_sent', audience: 'customer', trigger: 'Operations sends the customer a nomination of trucks.',
    body: 'Nomination {{1}}: {{2}} for loading at {{3}} on {{4}}. Tracking links go live at dispatch.',
    samples: ['NOM/26/0003', '2 trucks', 'Dar es Salaam port', '8 Nov'] }),
  utility({ name: 'approval_request', audience: 'approver', trigger: 'A request waits for this person\'s decision under the approval policy.',
    body: 'Your decision is needed: {{1}}. {{2}} Tap a button to decide.',
    buttons: ['Approve', 'Reject'], samples: ['Fuel request FUEL/26/0007, 600 L', 'Within the trip budget.'] }),
  utility({ name: 'advance_request', audience: 'finance', trigger: 'A driver needs money for a trip (the Advance request to Finance message).',
    body: 'Money needed: {{1}} asks for {{2}} for trip {{3}} ({{4}}). The reason given: {{5}}. Tap a button to decide.',
    buttons: ['Approve', 'Reject'], samples: ['Joseph Mwansa', 'ZMW 1,200', 'TRIP/26/0012', 'Dar es Salaam port to Lusaka fuel depot', 'border fees'],
    placeholders: ['{{driver.name}}', '{{currency}} {{amount}}', '{{trip.number}}', '{{route.name}}', '{{reason}}'] }),
  utility({ name: 'fleet_update', audience: 'anyone', trigger: 'Any message the company wrote itself (Masters → Message templates) that has no template of its own.',
    body: 'New message from your fleet office: {{1}} Reply here if you have a question.',
    samples: ['Your settlement is ready in the app.'] }),
] as const satisfies readonly WaTemplate[];

export type WaTemplateName = (typeof WA_TEMPLATES)[number]['name'];
export const waTemplate = (name: string) => WA_TEMPLATES.find((t) => t.name === name) as WaTemplate | undefined;
/** The carrier from #98: any message as its one variable, for company-written messages and as the last resort. */
export const CARRIER = 'fleet_update' satisfies WaTemplateName;

/** A message's template and the values for its body, in order: what a post to WhatsApp carries. */
export interface WaUse { template: WaTemplateName; values: string[] }

/** Template variables may not hold line breaks, tabs or long runs of spaces (Meta's rule). */
export const asVariable = (text: string) => text.replace(/\s*\n+\s*/g, ' · ').replace(/\t/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 1024);

/** The text with its values in, as the person will read it. */
export function fill(text: string, values: readonly string[]) {
  return text.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => values[Number(n) - 1] ?? `{{${n}}}`);
}

/** Problems with a template against Meta's rules, for the test and for anyone adding one. */
export function ruleProblems(t: WaTemplate): string[] {
  const out: string[] = [];
  const vars = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  if (!/^[a-z][a-z0-9_]{0,511}$/.test(t.name)) out.push('name is not snake_case');
  if (/^\s*\{\{\d+\}\}/.test(t.body)) out.push('the body starts with a variable');
  if (/\{\{\d+\}\}[\s.!?"]*$/.test(t.body)) out.push('the body ends with a variable');
  if (/\}\}\s*\{\{/.test(t.body)) out.push('two variables sit side by side');
  if (vars.some((n, i) => n !== i + 1)) out.push('variables are not numbered 1, 2, 3 in order');
  if (vars.length !== t.samples.length) out.push(`${vars.length} variables but ${t.samples.length} samples`);
  const words = t.body.replace(/\{\{\d+\}\}/g, '').split(/\s+/).filter(Boolean).length;
  if (vars.length && words / vars.length < 2) out.push('too many variables for the length');
  if (t.body.length > 1024) out.push('the body is longer than 1,024 characters');
  if ((t.buttons ?? []).some((b) => b.length > 25)) out.push('a button is longer than 25 characters');
  if ((t.buttons ?? []).length > 3) out.push('more than three quick replies');
  if (t.category !== 'UTILITY' && t.category !== 'AUTHENTICATION') out.push('category must be Utility or Authentication');
  return out;
}

/** The template as Meta's API takes it (POST /{waba-id}/message_templates), samples included. */
export function metaDefinition(t: WaTemplate) {
  return {
    name: t.name, category: t.category, language: t.language,
    components: [
      { type: 'HEADER', format: 'TEXT', text: t.header, example: { header_text: [HEADER_SAMPLE] } },
      { type: 'BODY', text: t.body, example: { body_text: [t.samples] } },
      ...(t.footer ? [{ type: 'FOOTER', text: t.footer }] : []),
      ...(t.buttons?.length ? [{ type: 'BUTTONS', buttons: t.buttons.map((text) => ({ type: 'QUICK_REPLY', text })) }] : []),
    ],
  };
}
