/**
 * Vercel Domains API integration for automatic custom-domain provisioning.
 *
 * When a tenant's custom domain is verified (CNAME check passes), we add the
 * domain to the Vercel project so Vercel serves it and issues TLS — no manual
 * dashboard step needed.
 *
 * Requires `VERCEL_API_TOKEN` and `VERCEL_PROJECT_ID`. When either is unset
 * (e.g. running on Replit, or auto-provisioning not configured), this is a
 * silent no-op: failures are logged and never surfaced to the tenant.
 */
export async function provisionVercelDomain(domain: string): Promise<void> {
  const token = process.env.VERCEL_API_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectId) {
    // Auto-provisioning not configured — skip silently.
    return;
  }

  try {
    const teamId = process.env.VERCEL_TEAM_ID;
    const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
    const res = await fetch(
      `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/domains${query}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: domain }),
      },
    );

    if (res.ok) {
      console.log(`[vercel-domains] Added ${domain} to Vercel project.`);
      return;
    }

    const body = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;

    // Already added — treat as success.
    if (body?.error?.code === "domain_already_in_use" && res.status === 409) {
      console.log(`[vercel-domains] ${domain} already on Vercel project.`);
      return;
    }

    console.error(
      `[vercel-domains] Failed to add ${domain} (HTTP ${res.status}): ${
        body?.error?.message ?? "unknown error"
      }`,
    );
  } catch (err) {
    console.error(`[vercel-domains] Error adding ${domain}:`, err);
  }
}
