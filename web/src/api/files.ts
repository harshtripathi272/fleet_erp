import { useQuery } from "@tanstack/react-query";
import { authorizedFetch } from "./client";

/** An uploaded file, as the API describes it. */
export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** Photos and PDFs the API accepts (it checks the bytes too). */
export const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,application/pdf";

/** Sends one file to file storage and returns its id, for a document to point at. */
export async function uploadFile(file: File): Promise<StoredFile> {
  const res = await authorizedFetch("/files", {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
    body: file,
  });
  return (await res.json()).data as StoredFile;
}

/** A local address for an uploaded file, fetched with the session (an <img> can't send the token). */
export function useFileUrl(fileId: string | undefined) {
  const query = useQuery({
    queryKey: ["file", fileId],
    queryFn: async () => URL.createObjectURL(await (await authorizedFetch(`/files/${fileId}`)).blob()),
    enabled: Boolean(fileId),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  });
  return query.data;
}

export const isPdf = (mime?: string) => mime === "application/pdf";
