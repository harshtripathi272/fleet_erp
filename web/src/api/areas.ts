import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

/** An area of the business the company can switch on and off (#56), as the server lists them. */
export interface Area { key: string; name: string; description: string; state: "live" | "early" | "not-built"; always?: boolean; on: boolean }

export const useAreaList = () => useQuery({ queryKey: ["areas"], queryFn: () => api<Area[]>("/meta/areas"), staleTime: 60_000 });

/** Whether an area is on. Until the list arrives, everything counts as on, so nothing flickers away. */
export function useAreas() {
  const { data } = useAreaList();
  return useCallback((key: string) => !data || data.some((a) => a.key === key && a.on), [data]);
}

/** What each desk view needs switched on. Views not listed need nothing beyond the masters. */
export const VIEW_AREA: Record<string, string> = { trips: "trips", nominations: "trips", accounts: "finance", today: "finance", driver: "driver-app", maintenance: "maintenance" };

/** Trucks held by a work order that stops them (#63), with the order's number. Empty while Maintenance is off. */
export function useHeldTrucks() {
  const { data: areas } = useAreaList();
  const { data } = useQuery({
    queryKey: ["held-trucks"],
    enabled: Boolean(areas?.some((a) => a.key === "maintenance" && a.on)),
    queryFn: () => api<{ vehicleId: string; number: string }[]>("/maintenance/held-trucks"),
    retry: false,
  });
  return new Map((data ?? []).map((h) => [h.vehicleId, h.number]));
}
