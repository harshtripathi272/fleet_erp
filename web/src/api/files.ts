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

/**
 * Sends one file to file storage and returns its id, for a document to point at. With `key`, sending the
 * same file again (after a dropped connection) returns the first upload instead of storing a second.
 */
export async function uploadFile(file: Blob, key?: string, name = (file as File).name ?? "document"): Promise<StoredFile> {
  const res = await authorizedFetch("/files", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(name),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
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

/**
 * Fetches a PDF the API makes (a trip sheet, a statement) with the session and hands it to the browser as a
 * file: saved, or opened in the phone's PDF viewer. A plain link can't carry the token, so it goes through here.
 */
export async function downloadPdf(path: string, fallbackName: string) {
  const res = await authorizedFetch(path);
  const named = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get("Content-Disposition") ?? "")?.[1];
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = named ? decodeURIComponent(named) : fallbackName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
