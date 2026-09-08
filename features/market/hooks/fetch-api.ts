import type { ApiErrorResponse } from "@/types/market";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** fetch wrapper that turns the API's error envelope into a typed throw. */
export async function fetchApi<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorResponse | null;
    throw new ApiError(
      body?.error?.code ?? "UNKNOWN",
      body?.error?.message ?? "Request failed. Please try again.",
      res.status,
    );
  }

  return (await res.json()) as T;
}
