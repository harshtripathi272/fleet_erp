import { SettingRow } from "./kit";

/**
 * Features decided on 5 Nov 2026 to come after the v1 trial (GitHub milestone "Coming soon"). Each shows where it
 * will live, marked "Coming soon", so a company sees what is planned without it looking broken. When one is
 * built, remove it here and the screen gets the real control.
 */
export type ComingSoonPlace = "company" | "accounts" | "connections" | "masters";
export const COMING_SOON: { key: string; place: ComingSoonPlace; name: string; description: string; issue: number; kind?: string }[] = [
  { key: "languages", place: "company", name: "Languages", description: "The whole app, documents and messages in another language, chosen by the company and by each person.", issue: 74 },
  { key: "api-keys", place: "company", name: "API keys", description: "Let the company's other software read and create records, each key with its own permissions.", issue: 58 },
  { key: "two-step", place: "accounts", name: "Two-step sign-in", description: "A code from a phone app or text message as well as the password.", issue: 58 },
  { key: "sign-in-codes", place: "accounts", name: "Sign-in codes by text message", description: "Drivers and staff sign in with a one-time code sent to their phone, no password to remember.", issue: 89 },
  { key: "phone-reset", place: "accounts", name: "Password reset by phone", description: "A forgotten password is reset with a code sent by text message or WhatsApp.", issue: 89 },
  { key: "branch-access", place: "accounts", name: "Branch access", description: "Staff see and change only their own branch's trucks, drivers and trips.", issue: 89 },
  { key: "gps-trackers", place: "connections", name: "Live GPS trackers", description: "Connecting a tracker service works now. Moving trucks on the map and marking arrivals from it is coming soon; until then positions are simulated.", issue: 60, kind: "gps" },
  { key: "road-routing", place: "connections", name: "Road routes from a map service", description: "Connecting a map service works now. Trip distances from its road routes are coming soon; until then the straight-line distance times the company's road factor is used.", issue: 60, kind: "routing" },
  { key: "field-permissions", place: "masters", name: "Field permissions by role", description: "Hide or lock a field for some roles.", issue: 68 },
  { key: "field-history", place: "masters", name: "Field history and copying a setup", description: "Safely change a field's type, see who changed the setup, and copy one company's setup to another.", issue: 69 },
];

/**
 * Masters built before anyone asked how they should work (Lakshya, 14 Nov): off the screens until they are designed
 * with a transporter. Their records and the engine under rate contracts stay; the list shows them as "Coming soon".
 */
export const COMING_SOON_MASTERS: Record<string, string> = {
  tariffs: "Price rules beyond a rate contract: slabs, formulas, extra drops and shortage deductions. Until then a customer's price comes from its rate contract, or the rate typed on the consignment.",
  "customer-rates": "Prices for invoicing trips without consignments. Until then a customer's price comes from its rate contract, or the rate typed on the consignment.",
};

export function ComingSoonTag() {
  return <span className="status status-mute coming-soon">Coming soon</span>;
}

/** The coming-soon features that belong on one screen, as setting rows. */
export function ComingSoonRows({ place }: { place: ComingSoonPlace }) {
  return (
    <>
      {COMING_SOON.filter((f) => f.place === place).map((f) => (
        <SettingRow key={f.key} title={f.name} description={f.description}>
          <ComingSoonTag />
        </SettingRow>
      ))}
    </>
  );
}
