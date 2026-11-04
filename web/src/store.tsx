import { createContext, useCallback, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { toAppData, type Operations, type Rec, type Reference } from "./api/adapter";
import { all, api, ApiError } from "./api/client";
import { Refusal, runCommand } from "./api/commands";
import type { Approver, Me } from "./api/session";
import type { Action, AppData, Nav, Role } from "./domain/types";

export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } });

/** A list the user may not read is simply empty. */
async function list(path: string, query: Record<string, string> = {}): Promise<Rec[]> {
  try {
    return await all<Rec>(path, query);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return [];
    throw error;
  }
}

async function loadReference(me: Me): Promise<Reference> {
  const [company, currencies, rates, countries, cities, places, borderPosts, routes, tripBudgets, parties, orderSources, vehicles, vehicleModels, fuelNorms, trailers, trailerTypes, pairings, drivers, branches, products, units, categories, paymentMethods] = await Promise.all([
    api<Rec>("/company").catch(() => null),
    list("/currencies", { status: "all" }), list("/exchange-rates"), list("/countries"), list("/cities"), list("/places", { status: "all" }), list("/border-posts"),
    list("/routes"), list("/trip-budgets"), list("/parties", { status: "all" }), list("/order-sources"), list("/vehicles", { status: "all" }), list("/vehicle-models"),
    list("/fuel-norms"), list("/trailers", { status: "all" }), list("/trailer-types"), list("/pairings", { status: "all" }), list("/drivers", { status: "all" }),
    list("/branches"), list("/products", { status: "all" }), list("/units"), list("/expense-categories", { status: "all" }), list("/payment-methods"),
  ]);
  return { me: { id: me.id, name: me.name, roles: me.roles, permissions: me.permissions }, company, currencies, rates, countries, cities, places, borderPosts, routes, tripBudgets, parties, orderSources, vehicles, vehicleModels, fuelNorms, trailers, trailerTypes, pairings, drivers, branches, products, units, categories, paymentMethods };
}

/** Who approval policies name, by role key or user id, with the level, for offering desks. */
async function loadApprovers(): Promise<Approver[]> {
  const [policies, roles] = await Promise.all([list("/approval-policies"), list("/roles")]);
  const keys = new Map(roles.map((r) => [String(r.id), String(r.key)]));
  return policies.flatMap((p) => (p.levels ?? []).map((l: Rec) => ({ level: Number(l.level), roleKey: l.approverRoleId ? keys.get(String(l.approverRoleId)) : undefined, userId: l.approverUserId })));
}

/* ---------- Trip-side records, merged from the incremental sync ---------- */

type Collection = Exclude<keyof Operations, "reads">;
const COLLECTIONS: Collection[] = ["trips", "requests", "documents", "consignments", "expenses", "settlements", "nominations", "vehicleStates", "driverAccounts", "messages", "activity"];

interface Synced { userId: string; since?: string; maps: Record<Collection, Map<string, Rec>>; reads: Operations["reads"] }
let synced: Synced | null = null;

async function syncOperations(userId: string): Promise<Operations> {
  if (synced?.userId !== userId) synced = { userId, maps: Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()])) as Synced["maps"], reads: [] };
  const state = synced;
  // Like the lists above: someone who may not read trips (an auditor, say) still gets the app, with no trips in it.
  const res = await api<Rec>("/operations/sync", { query: { since: state.since } }).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 403) return {} as Rec;
    throw error;
  });
  for (const c of COLLECTIONS) for (const row of (res[c] ?? []) as Rec[]) state.maps[c].set(String(row.id), row);
  state.reads = res.reads ?? [];
  state.since = res.serverTime;
  return { ...(Object.fromEntries(COLLECTIONS.map((c) => [c, [...state.maps[c].values()]])) as Omit<Operations, "reads">), reads: state.reads };
}

export function useSharedData(me: Me) {
  const client = useQueryClient();
  const reference = useQuery({ queryKey: ["reference", me.id], queryFn: () => loadReference(me), refetchInterval: 60_000, staleTime: 30_000 });
  const operations = useQuery({ queryKey: ["operations", me.id], queryFn: () => syncOperations(me.id), refetchInterval: 4_000 });
  const policies = useQuery({ queryKey: ["approvers", me.id], queryFn: loadApprovers, staleTime: 60_000 });
  const data = useMemo(() => (reference.data && operations.data ? toAppData(reference.data, operations.data) : null), [reference.data, operations.data]);
  const perform = useCallback(
    async (action: Action, role: Role) => {
      if (!data) throw new Refusal("Still loading.");
      await runCommand(action, { data, role, meId: me.id });
      await client.refetchQueries({ queryKey: ["operations", me.id] });
    },
    [client, data, me.id],
  );
  const refreshReference = useCallback(() => client.invalidateQueries({ queryKey: ["reference", me.id] }), [client, me.id]);
  return { data, approvers: policies.data ?? [], perform, refreshReference, error: reference.error ?? operations.error, loading: reference.isLoading || operations.isLoading };
}

export function resetSync() {
  synced = null;
}

export interface Toast {
  id: number;
  text: string;
  tone: "ok" | "error";
}

export interface Overlay {
  tracking?: string;
  document?: { kind: "trip-sheet" | "statement" | "voucher" | "photo"; id: string };
  phone?: boolean;
}

interface Ctx {
  data: AppData;
  role: Role;
  me: Me;
  driverId?: string;
  /** Runs an action on the API; resolves true when it worked (failures are shown as a toast). */
  run: (action: Action, success?: string) => Promise<boolean>;
  refreshReference: () => void;
  nav: (target: Nav) => void;
  overlay: Overlay;
  setOverlay: (next: Overlay) => void;
  toast: (text: string, tone?: Toast["tone"]) => void;
}

const AppContext = createContext<Ctx | null>(null);
export const useApp = () => useContext(AppContext)!;

export function AppProvider({ value, children }: { value: Ctx; children: ReactNode }) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
