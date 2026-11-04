# Master of masters: every record type is defined by data

Lakshya's core idea for the app. One company's driver has a union number and a blood group. Another company's driver has neither, but has a medical certificate and two next of kin. A third company calls drivers "crew". The same is true of trucks, customers, trips, fuel requests, expenses, loadings and invoices: **every kind of record**.

The app can't hard-code any of these. It ships with a sensible starting definition for each kind of record, and each company reshapes it on screen. What a company defines reaches every place the record appears, with no code change.

This document is the design. Issue #65 builds phase 1, and later phases have their own issues.

## Words

- **Record type.** Any kind of record:
  - every master (59 today);
  - every operational record: trip, nomination, fuel or cash request, expense, loading, delivery, settlement, and later invoice and work order;
  - every custom master a company adds.

  All of them share one definition shape.
- **Field.** One piece of a record: its key, type, rules and how it shows.
- **Built-in field.** Defined in code because logic reads it (a trip's truck, a loading's litres at 20 °C). A company can rename it, hint it, make it stricter, hide it if nothing depends on it, and move it. It can never break it.
- **Company field.** Defined by the company. Stored under `custom.<key>` on the record. Fully the company's.
- **Choice list.** The values a choice field offers. Lists the code acts on (an approval level's measure) are *locked*: their values can be renamed and reordered, but not removed or added to. Every other list is the company's.
- **Effective definition.** Code base + company layer, merged. This is the only definition anything outside the engine ever sees.

## The layers

```
code base (src)                     company layer (database, audited)
──────────────────────              ─────────────────────────────────────────
built-in fields + rules             overrides on built-in fields
labels, hints, choice names         company fields
locked choice lists                 company choice lists, names for locked values
default form order and sections     sections, order, list columns, placements
                │                                 │
                └───────────── merge ─────────────┘
                                │
                     effective definition (versioned, cached)
                                │
     API validation · /meta · forms · lists · drawers · import/export · documents ·
     message placeholders · driver app · search · audit names · API console
```

The code base is versioned with the app. The company layer is one record per record type: overrides, fields, choices and layout. Every change to it is audited, and any part can be reset to the code's default. The merged result carries a version number. Caches and compiled validators are keyed by that version, so a change takes effect on the next request with no restart.

## What a company can do with each field

| | Built-in field | Company field |
|---|---|---|
| Rename, hint | yes | yes |
| Hide | only if nothing depends on it (the definition says which do) | yes |
| Required | stricter only | yes |
| Default value | yes | yes |
| Section, order, list column, searchable, in import | yes | yes |
| Who can see / edit (roles), sensitive | stricter only | yes |
| Change type | no | only safe conversions (text → long text, choice → multi-choice); otherwise add a new field |
| Delete | no | archive; stored values are kept and stay readable |

**Keys never change.** Names do. Renaming a field never touches stored data.

## Field types

| Type | Notes |
|---|---|
| Text, long text | |
| Number | With an optional unit from Units of measure (L, kg, km) |
| Money | An amount and a currency; stored in minor units |
| Date, date and time | |
| Yes/no | |
| Choice, multi-choice | From a choice list |
| Reference, multi-reference | To any record type, custom masters included |
| Phone, e-mail | |
| File, photo | Stored through the storage connection |

The list of types is itself a registry. A new type is one entry: validator, input, display, import parser and export.

## Operational records: placements

A master is edited in one form. A trip is filled in step by step on purpose-built desks: created, funded, loaded, dispatched, delivered, closed. So a company field on an operational record names its **placement**: the step where it's asked, who answers it (office or driver), and whether it's required at that step.

Each built-in workflow declares its placements in code. For example:

- trip: create, dispatch, loading, arrival, delivery, close;
- request: ask, approve, pay;
- expense: submit, approve.

The desks and the driver app draw a "company fields" block at each placement, using the same generic inputs as the masters form. The step's API checks those fields with the effective definition. The step can't complete until its required company fields are filled.

## Every surface uses the effective definition

- **API:** create, update and each workflow step are checked by a validator compiled from the effective definition: the code's schema, then the company's stricter rules, then company fields.
- **`/meta/entities`** (today's `/meta/masters`, widened): one definition per record type, for the caller's permissions.
- **Screens:** forms, lists, drawers, filters and search for masters; placement blocks on desks and in the driver app.
- **Import and export:** columns, names, required marks and choice names follow the definition. The old names and values are still accepted.
- **Documents:** a field can be marked to print on the trip sheet, statement, invoice and so on.
- **Messages:** every field is a placeholder (`{{driver.custom.unionNo}}`), and the template editor lists them.
- **Audit log and history:** field names come from the definition.
- **Search:** company fields marked searchable are searched through a wildcard index on `custom`.

## Moving today's data

- **Custom fields** (FieldDefinition) become company fields of their record type. Keys and values are unchanged.
- **Custom masters** become company record types. Their records stay where they are.
- **Simple lists** become company choice lists.
- **The labels, hints and choice names in code** (#51) become the code base layer.

## Phases

1. **Masters (#65).**
   - The company layer and merge.
   - Overrides on built-in fields; company fields from the same screen; choice lists (names, order, retiring values).
   - Master settings: name, description, group, area, shown.
   - API validation, `/meta`, forms, lists, drawer and import follow the definition.
   - The Customise screen.
2. **Operational records.**
   - Company fields and placements on trips, nominations, requests, expenses, loadings and deliveries, and settlements.
   - Placement blocks on the desks and in the driver app.
   - Fields on documents and as message placeholders.
3. **Record types as one family.**
   - Custom masters move into the same definition and screen.
   - References to any record type.
   - Field-level permissions by role.
   - Saved list views per role.
4. **Scale.**
   - Safe type conversions with data migration.
   - The history of each definition.
   - Export and import of a company's whole configuration, to copy a set-up to a new company or a test copy.
