/**
 * Thin iFramer API client for creating framing jobs from Artwork Bank orders.
 *
 * Required environment secrets:
 *   IFRAMER_API_BASE_URL  — e.g. https://api.iframer.com.au/v1
 *   IFRAMER_API_KEY       — bearer token issued by iFramer
 */

export interface IFramerJobInput {
  /** iFramer account the job belongs to */
  accountId: string;
  /** Artwork title shown in the job */
  artworkTitle: string;
  /** Width in metres */
  widthM: number | null;
  /** Height in metres */
  heightM: number | null;
  /** Condition label from Artwork Bank */
  condition: string | null;
  /** Artwork Bank order ID for traceability */
  sourceOrderId: string;
  /** Artwork Bank artwork ID for traceability */
  sourceArtworkId: string;
}

export interface IFramerJobResult {
  jobId: string;
}

export class IFramerError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "IFramerError";
  }
}

/**
 * Create a framing job in iFramer for a paid FRAMING_JOB order.
 *
 * Throws `IFramerError` on any failure so the caller can persist the error message.
 * Never throws generic errors — always wraps in IFramerError.
 */
export async function createIFramerJob(
  input: IFramerJobInput,
): Promise<IFramerJobResult> {
  const baseUrl = process.env.IFRAMER_API_BASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.IFRAMER_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new IFramerError(
      "iFramer integration not configured: IFRAMER_API_BASE_URL and IFRAMER_API_KEY must be set.",
    );
  }

  const endpoint = `${baseUrl}/accounts/${encodeURIComponent(input.accountId)}/jobs`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "ArtworkBank/1.0",
      },
      body: JSON.stringify({
        title: input.artworkTitle,
        width_m: input.widthM,
        height_m: input.heightM,
        condition: input.condition,
        source_order_id: input.sourceOrderId,
        source_artwork_id: input.sourceArtworkId,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    throw new IFramerError(
      `Network error contacting iFramer API: ${err?.message ?? "unknown error"}`,
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.message ?? body?.error ?? JSON.stringify(body);
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new IFramerError(
      `iFramer API returned ${res.status}: ${detail || res.statusText}`,
      res.status,
    );
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new IFramerError("iFramer API returned a non-JSON success response.");
  }

  const jobId = data?.id ?? data?.job_id ?? data?.jobId;
  if (!jobId || typeof jobId !== "string") {
    throw new IFramerError(
      `iFramer API response missing job ID. Got: ${JSON.stringify(data)}`,
    );
  }

  return { jobId };
}
