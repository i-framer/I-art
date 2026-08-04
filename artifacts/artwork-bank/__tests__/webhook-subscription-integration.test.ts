/**
 * Integration tests for subscription webhook events against a real database.
 *
 * These complement the mock-based webhook-subscription.test.ts by exercising:
 *  1. All three tenant-lookup paths (billingTenantId metadata, stripeCustomerId,
 *     stripeSubscriptionId) against real DB rows.
 *  2. The out-of-order guard: a customer.subscription.deleted event processed
 *     before customer.subscription.updated must leave the tenant canceled, not
 *     active.
 *  3. The no-match ERROR path: an event that matches no tenant writes a
 *     stripe_alert row and logs an error.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { describeIntegration } from "./helpers/skip-if-no-db";
import { randomUUID } from "node:crypto";

// ── Stub out non-DB collaborators; keep the real @workspace/db untouched ─────

vi.mock("@/lib/stripe", () => ({
  getStripeClient: vi.fn(),
  getStripeWebhookSecret: vi.fn().mockResolvedValue(null),
  calcApplicationFee: (cents: number) => Math.round(cents * 0.05),
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(),
  sendBillingAlertNotification: vi.fn(),
}));
vi.mock("@/lib/slack", () => ({ sendBillingAlertSlackNotification: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("@/lib/iframer", () => ({
  createIFramerJob: vi.fn(),
  IFramerError: class IFramerError extends Error {},
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/base-url", () => ({ getTenantUrl: vi.fn() }));

// ── Real DB + webhook handler ─────────────────────────────────────────────────

import { db, tenantsTable, stripeAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";
import { sendBillingAlertNotification } from "@/lib/email";
import { getStripeClient } from "@/lib/stripe";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return randomUUID();
}

/** Insert a minimal tenant row and return its id. */
async function createTenant(overrides: {
  id?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  subscriptionStatus?: string;
} = {}) {
  const id = overrides.id ?? uid();
  const slug = `test-${id}`;
  await db.insert(tenantsTable).values({
    id,
    type: "ARTIST",
    businessName: "Test Gallery",
    slug,
    stripeCustomerId: overrides.stripeCustomerId ?? null,
    stripeSubscriptionId: overrides.stripeSubscriptionId ?? null,
    subscriptionStatus: overrides.subscriptionStatus ?? null,
  } as any);
  return id;
}

/** Read back the subscription fields for a tenant. */
async function getTenantBillingFields(id: string) {
  return db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.id, id),
    columns: {
      subscriptionStatus: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
    },
  });
}

/** Send a fake webhook event through the POST handler (dev-bypass mode). */
function post(event: object) {
  return webhookPOST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify(event),
    }),
  );
}

// Track tenant IDs created per test so we can clean them up.
const createdTenantIds: string[] = [];
const createdAlertEventIds: string[] = [];

beforeEach(() => {
  process.env.STRIPE_WEBHOOK_DEV_BYPASS = "true";
  createdTenantIds.length = 0;
  createdAlertEventIds.length = 0;
});

afterEach(async () => {
  delete process.env.STRIPE_WEBHOOK_DEV_BYPASS;
  // Clean up in FK-safe order: alerts first (no FK), then tenants.
  for (const eventId of createdAlertEventIds) {
    await db
      .delete(stripeAlertsTable)
      .where(eq(stripeAlertsTable.stripeEventId, eventId))
      .catch(() => {});
  }
  for (const id of createdTenantIds) {
    await db
      .delete(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .catch(() => {});
  }
});

// ── Lookup path: billingTenantId metadata ─────────────────────────────────────

describeIntegration("tenant lookup by billingTenantId metadata", () => {
  it("customer.subscription.updated mirrors status onto the matched tenant row", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const res = await post({
      id: `evt_meta_${tenantId}`,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: `sub_meta_${tenantId}`,
          status: "past_due",
          customer: `cus_meta_${tenantId}`,
          metadata: { billingTenantId: tenantId },
        },
      },
    });

    expect(res.status).toBe(200);

    const row = await getTenantBillingFields(tenantId);
    expect(row?.subscriptionStatus).toBe("past_due");
    expect(row?.stripeSubscriptionId).toBe(`sub_meta_${tenantId}`);
    expect(row?.stripeCustomerId).toBe(`cus_meta_${tenantId}`);
  });

  it("customer.subscription.deleted marks the tenant canceled via metadata lookup", async () => {
    const tenantId = await createTenant({
      stripeCustomerId: `cus_del_${uid()}`,
      subscriptionStatus: "active",
    });
    createdTenantIds.push(tenantId);

    const subId = `sub_del_${tenantId}`;
    const res = await post({
      id: `evt_del_${tenantId}`,
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: subId,
          status: "canceled",
          customer: `cus_del_${tenantId}`,
          metadata: { billingTenantId: tenantId },
        },
      },
    });

    expect(res.status).toBe(200);

    const row = await getTenantBillingFields(tenantId);
    expect(row?.subscriptionStatus).toBe("canceled");
  });
});

// ── Lookup path: stripeCustomerId ─────────────────────────────────────────────

describeIntegration("tenant lookup by stripeCustomerId (no metadata)", () => {
  it("customer.subscription.updated matches by customer ID and updates status", async () => {
    const cusId = `cus_byid_${uid()}`;
    const tenantId = await createTenant({ stripeCustomerId: cusId });
    createdTenantIds.push(tenantId);

    const subId = `sub_byid_${tenantId}`;
    const res = await post({
      id: `evt_byid_${tenantId}`,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: subId,
          status: "trialing",
          customer: cusId,
          metadata: {}, // no billingTenantId
        },
      },
    });

    expect(res.status).toBe(200);

    const row = await getTenantBillingFields(tenantId);
    expect(row?.subscriptionStatus).toBe("trialing");
    expect(row?.stripeCustomerId).toBe(cusId);
    expect(row?.stripeSubscriptionId).toBe(subId);
  });
});

// ── Lookup path: stripeSubscriptionId ─────────────────────────────────────────

describeIntegration("tenant lookup by stripeSubscriptionId (no metadata, no customer match)", () => {
  it("customer.subscription.updated matches by subscription ID alone", async () => {
    const subId = `sub_bysubid_${uid()}`;
    const tenantId = await createTenant({ stripeSubscriptionId: subId });
    createdTenantIds.push(tenantId);

    const res = await post({
      id: `evt_bysubid_${tenantId}`,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: subId,
          status: "active",
          // customer is null so the code falls through to subscription-ID lookup
          customer: null,
          metadata: {}, // no billingTenantId
        },
      },
    });

    expect(res.status).toBe(200);

    const row = await getTenantBillingFields(tenantId);
    expect(row?.subscriptionStatus).toBe("active");
    expect(row?.stripeSubscriptionId).toBe(subId);
  });
});

// ── checkout.session.completed reactivation via customer ID ──────────────────

describeIntegration("checkout.session.completed re-subscription matched by stripeCustomerId", () => {
  it("reactivates a canceled tenant when checkout carries a known customer ID but no billingTenantId metadata", async () => {
    const cusId = `cus_checkout_reactivate_${uid()}`;
    const subOld = `sub_old_checkout_${uid()}`;

    const tenantId = await createTenant({
      stripeCustomerId: cusId,
      stripeSubscriptionId: subOld,
      subscriptionStatus: "canceled",
    });
    createdTenantIds.push(tenantId);

    const subNew = `sub_new_checkout_${uid()}`;

    const res = await post({
      id: `evt_checkout_reactivate_${tenantId}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_reactivate_${tenantId}`,
          mode: "subscription",
          customer: cusId,
          subscription: subNew,
          metadata: {}, // no billingTenantId — must fall back to stripeCustomerId
        },
      },
    });

    expect(res.status).toBe(200);

    const row = await getTenantBillingFields(tenantId);
    expect(row?.subscriptionStatus).toBe("active");
    expect(row?.stripeSubscriptionId).toBe(subNew);
    expect(row?.stripeCustomerId).toBe(cusId);
  });
});

// ── Checkout re-delivery guard ───────────────────────────────────────────────

describeIntegration("checkout.session.completed re-delivery blocked for same subscription ID", () => {
  it("does NOT reset subscriptionStatus to active when same sub ID is already on the tenant (customer-ID lookup path)", async () => {
    // Simulate a tenant that was active, then a customer.subscription.deleted
    // event ran and set it to "canceled".  The checkout.session.completed event
    // for the original purchase is re-delivered (e.g. Stripe retries it).
    // Because the subscription ID matches the one already stored, isNewSubscription
    // evaluates to false and the status must stay "canceled".
    const cusId = `cus_checkout_redeliver_${uid()}`;
    const subId = `sub_checkout_redeliver_${uid()}`;

    const tenantId = await createTenant({
      stripeCustomerId: cusId,
      stripeSubscriptionId: subId,
      subscriptionStatus: "canceled",
    });
    createdTenantIds.push(tenantId);

    const res = await post({
      id: `evt_checkout_redeliver_${tenantId}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_redeliver_${tenantId}`,
          mode: "subscription",
          customer: cusId,         // same customer
          subscription: subId,     // same subscription — must be blocked
          metadata: {},            // no billingTenantId — exercises customer-ID lookup path
        },
      },
    });

    expect(res.status).toBe(200);

    const row = await getTenantBillingFields(tenantId);
    // Must remain "canceled" — the checkout re-delivery must NOT flip it back.
    expect(row?.subscriptionStatus).toBe("canceled");
    expect(row?.stripeSubscriptionId).toBe(subId);
    expect(row?.stripeCustomerId).toBe(cusId);
  });
});

// ── Checkout re-delivery on already-active tenant (happy path) ───────────────

describeIntegration("checkout.session.completed re-delivery when tenant is already active", () => {
  it("is a no-op — subscriptionStatus stays active and stripeSubscriptionId is unchanged", async () => {
    // Tenant is active with sub_X. The original checkout.session.completed event
    // is re-delivered by Stripe (e.g. a network retry). Because isNewSubscription
    // evaluates to false (same sub ID, status already set), the handler must NOT
    // overwrite the current state.
    const cusId = `cus_checkout_happy_redeliver_${uid()}`;
    const subId = `sub_checkout_happy_redeliver_${uid()}`;

    const tenantId = await createTenant({
      stripeCustomerId: cusId,
      stripeSubscriptionId: subId,
      subscriptionStatus: "active",
    });
    createdTenantIds.push(tenantId);

    const res = await post({
      id: `evt_checkout_happy_redeliver_${tenantId}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_happy_redeliver_${tenantId}`,
          mode: "subscription",
          customer: cusId,       // same customer
          subscription: subId,   // same subscription — isNewSubscription → false
          metadata: {},          // no billingTenantId — exercises customer-ID lookup path
        },
      },
    });

    expect(res.status).toBe(200);

    const row = await getTenantBillingFields(tenantId);
    // Status must remain "active" — the re-delivery is a clean no-op.
    expect(row?.subscriptionStatus).toBe("active");
    expect(row?.stripeSubscriptionId).toBe(subId);
    expect(row?.stripeCustomerId).toBe(cusId);
  });
});

// ── Checkout re-delivery (billingTenantId metadata path, active tenant) ──────

describeIntegration("checkout.session.completed re-delivery via billingTenantId metadata when tenant is already active", () => {
  it("is a no-op — subscriptionStatus stays active and stripeSubscriptionId is unchanged", async () => {
    // Tenant is active with sub_X. A checkout.session.completed event that
    // carries billingTenantId in its metadata is re-delivered by Stripe (e.g. a
    // network retry). Because isNewSubscription evaluates to false (same sub ID,
    // status already set), the handler must NOT overwrite the current state.
    const cusId = `cus_meta_happy_redeliver_${uid()}`;
    const subId = `sub_meta_happy_redeliver_${uid()}`;

    const tenantId = await createTenant({
      stripeCustomerId: cusId,
      stripeSubscriptionId: subId,
      subscriptionStatus: "active",
    });
    createdTenantIds.push(tenantId);

    const res = await post({
      id: `evt_meta_happy_redeliver_${tenantId}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_meta_happy_redeliver_${tenantId}`,
          mode: "subscription",
          customer: cusId,
          subscription: subId,   // same subscription — isNewSubscription → false
          metadata: { billingTenantId: tenantId }, // exercises the metadata lookup path
        },
      },
    });

    expect(res.status).toBe(200);

    const row = await getTenantBillingFields(tenantId);
    // Status must remain "active" — the re-delivery via metadata path is a clean no-op.
    expect(row?.subscriptionStatus).toBe("active");
    expect(row?.stripeSubscriptionId).toBe(subId);
  });
});

// ── checkout.session.completed with trialing subscription ────────────────────

describeIntegration("checkout.session.completed with trialing subscription", () => {
  it("stores 'trialing' when subscriptions.retrieve returns status=trialing", async () => {
    // A new tenant subscribes via Checkout but their subscription is in trial.
    // The handler calls subscriptions.retrieve to get the real status, so it
    // must store "trialing" — not silently default to "active".
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const subId = `sub_trialing_chk_${uid()}`;
    const cusId = `cus_trialing_chk_${uid()}`;

    // Make getStripeClient return a minimal fake whose subscriptions.retrieve
    // resolves to { status: "trialing" } so the retrieve call succeeds.
    vi.mocked(getStripeClient).mockResolvedValueOnce({
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({ status: "trialing" }),
      },
    } as any);

    const res = await post({
      id: `evt_checkout_trialing_${tenantId}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_trialing_${tenantId}`,
          mode: "subscription",
          customer: cusId,
          subscription: subId,
          metadata: { billingTenantId: tenantId },
        },
      },
    });

    expect(res.status).toBe(200);

    const row = await getTenantBillingFields(tenantId);
    // Must be "trialing" — not "active". The retrieve path is the only way to
    // know the real Stripe status at checkout time; skipping it would silently
    // promote a trial to active.
    expect(row?.subscriptionStatus).toBe("trialing");
    expect(row?.stripeSubscriptionId).toBe(subId);
    expect(row?.stripeCustomerId).toBe(cusId);
  });
});

// ── Out-of-order guard ────────────────────────────────────────────────────────

describeIntegration("out-of-order subscription events", () => {
  it("deleted processed before updated leaves the tenant canceled, not active", async () => {
    const tenantId = await createTenant({ subscriptionStatus: "active" });
    createdTenantIds.push(tenantId);

    const subId = `sub_ooo_${tenantId}`;
    const cusId = `cus_ooo_${tenantId}`;

    // Step 1: deleted arrives first → tenant should become canceled.
    const delRes = await post({
      id: `evt_del_ooo_${tenantId}`,
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: subId,
          status: "canceled",
          customer: cusId,
          metadata: { billingTenantId: tenantId },
        },
      },
    });
    expect(delRes.status).toBe(200);

    const afterDel = await getTenantBillingFields(tenantId);
    expect(afterDel?.subscriptionStatus).toBe("canceled");

    // Step 2: stale updated event arrives late with a live status.
    // The out-of-order guard must prevent it from re-activating the tenant.
    const updRes = await post({
      id: `evt_upd_ooo_${tenantId}`,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: subId, // same sub — should be blocked by the cancel guard
          status: "active",
          customer: cusId,
          metadata: { billingTenantId: tenantId },
        },
      },
    });
    expect(updRes.status).toBe(200);

    const afterUpd = await getTenantBillingFields(tenantId);
    expect(afterUpd?.subscriptionStatus).toBe("canceled"); // must NOT flip to "active"
  });

  it("a stale updated event does NOT create a stripe_alert row (it is a silent no-op)", async () => {
    const tenantId = await createTenant({ subscriptionStatus: "active" });
    createdTenantIds.push(tenantId);

    const subId = `sub_alert_ooo_${tenantId}`;
    const cusId = `cus_alert_ooo_${tenantId}`;
    const staleEventId = `evt_stale_${tenantId}`;
    // No stripe_alert to clean up — the whole point is that none is created.

    // Step 1: deleted arrives and cancels the tenant.
    await post({
      id: `evt_del_alert_${tenantId}`,
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: subId,
          status: "canceled",
          customer: cusId,
          metadata: { billingTenantId: tenantId },
        },
      },
    });

    // Step 2: stale updated event arrives — blocked by the cancel guard.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({
      id: staleEventId,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: subId,
          status: "active",
          customer: cusId,
          metadata: { billingTenantId: tenantId },
        },
      },
    });
    expect(res.status).toBe(200);

    // Status still canceled — no false re-activation.
    const row = await getTenantBillingFields(tenantId);
    expect(row?.subscriptionStatus).toBe("canceled");

    // No error logged — this was an expected no-op, not an unmatched event.
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Unmatched subscription event"),
    );
    errorSpy.mockRestore();

    // No billing alert row created.
    const alert = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.stripeEventId, staleEventId),
    });
    expect(alert).toBeUndefined();
  });

  it("a NEW subscription (different sub ID) re-activates a previously canceled tenant via customer.subscription.created", async () => {
    const subOld = `sub_old_${uid()}`;
    const tenantId = await createTenant({
      subscriptionStatus: "canceled",
      stripeSubscriptionId: subOld,
    });
    createdTenantIds.push(tenantId);

    const subNew = `sub_new_${uid()}`;
    const cusId = `cus_new_${tenantId}`;

    const res = await post({
      id: `evt_new_sub_${tenantId}`,
      type: "customer.subscription.created",
      data: {
        object: {
          id: subNew, // different sub ID → cancel guard allows the update
          status: "active",
          customer: cusId,
          metadata: { billingTenantId: tenantId },
        },
      },
    });
    expect(res.status).toBe(200);

    const row = await getTenantBillingFields(tenantId);
    expect(row?.subscriptionStatus).toBe("active");
    expect(row?.stripeSubscriptionId).toBe(subNew);
  });

  it("a NEW subscription (different sub ID) re-activates a previously canceled tenant via customer.subscription.updated", async () => {
    const subOld = `sub_old_upd_${uid()}`;
    const tenantId = await createTenant({
      subscriptionStatus: "canceled",
      stripeSubscriptionId: subOld,
    });
    createdTenantIds.push(tenantId);

    const subNew = `sub_new_upd_${uid()}`;
    const cusId = `cus_new_upd_${tenantId}`;

    const res = await post({
      id: `evt_new_sub_upd_${tenantId}`,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: subNew, // different sub ID → cancel guard allows the update
          status: "active",
          customer: cusId,
          metadata: { billingTenantId: tenantId },
        },
      },
    });
    expect(res.status).toBe(200);

    const row = await getTenantBillingFields(tenantId);
    expect(row?.subscriptionStatus).toBe("active");
    expect(row?.stripeSubscriptionId).toBe(subNew);
  });
});

// ── invoice.payment_failed matched path ──────────────────────────────────────

describeIntegration("invoice.payment_failed matched path", () => {
  it("sets subscriptionStatus to past_due on the matched tenant row", async () => {
    const cusId = `cus_inv_pd_${uid()}`;
    const tenantId = await createTenant({
      stripeCustomerId: cusId,
      subscriptionStatus: "active",
    });
    createdTenantIds.push(tenantId);

    const eventId = `evt_inv_pd_${tenantId}`;
    const res = await post({
      id: eventId,
      type: "invoice.payment_failed",
      data: {
        object: {
          id: `in_pd_${tenantId}`,
          customer: cusId,
        },
      },
    });

    expect(res.status).toBe(200);

    const row = await getTenantBillingFields(tenantId);
    expect(row?.subscriptionStatus).toBe("past_due");
  });

  it("does NOT overwrite canceled status — a late invoice failure must not revive a canceled tenant", async () => {
    // A tenant that was previously canceled (subscription ended) may still
    // receive a late invoice.payment_failed event for their final unpaid
    // invoice. The handler must leave the status as 'canceled' rather than
    // flipping it to 'past_due'.
    const cusId = `cus_inv_canceled_${uid()}`;
    const tenantId = await createTenant({
      stripeCustomerId: cusId,
      subscriptionStatus: "canceled",
    });
    createdTenantIds.push(tenantId);

    const eventId = `evt_inv_canceled_${tenantId}`;
    // Spy to confirm no error is logged and no false billing alert is created.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await post({
      id: eventId,
      type: "invoice.payment_failed",
      data: {
        object: {
          id: `in_canceled_${tenantId}`,
          customer: cusId,
        },
      },
    });

    expect(res.status).toBe(200);

    const row = await getTenantBillingFields(tenantId);
    // Status must remain 'canceled' — not flipped to 'past_due'.
    expect(row?.subscriptionStatus).toBe("canceled");

    // Must NOT log an error — this is an expected no-op, not an unmatched event.
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Unmatched invoice.payment_failed"),
    );
    errorSpy.mockRestore();

    // Must NOT create a false billing alert row.
    const alert = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.stripeEventId, eventId),
    });
    expect(alert).toBeUndefined();
  });

  it("sets past_due when the tenant starts as trialing (non-canceled path still works)", async () => {
    const cusId = `cus_inv_trialing_${uid()}`;
    const tenantId = await createTenant({
      stripeCustomerId: cusId,
      subscriptionStatus: "trialing",
    });
    createdTenantIds.push(tenantId);

    const eventId = `evt_inv_trialing_${tenantId}`;
    const res = await post({
      id: eventId,
      type: "invoice.payment_failed",
      data: {
        object: {
          id: `in_trialing_${tenantId}`,
          customer: cusId,
        },
      },
    });

    expect(res.status).toBe(200);

    const row = await getTenantBillingFields(tenantId);
    expect(row?.subscriptionStatus).toBe("past_due");
  });
});

// ── No-match ERROR path ───────────────────────────────────────────────────────

describeIntegration("no-match error path against real DB", () => {
  it("writes a stripe_alert row and logs an error when no tenant matches a subscription event", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const eventId = `evt_nomatch_integ_${uid()}`;
    createdAlertEventIds.push(eventId);

    const res = await post({
      id: eventId,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: `sub_ghost_${uid()}`,
          status: "active",
          customer: `cus_ghost_${uid()}`,
          metadata: {}, // no billingTenantId, customer/sub IDs don't exist in DB
        },
      },
    });

    expect(res.status).toBe(200);

    // ERROR was logged
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unmatched subscription event"),
    );

    // A billing alert row was persisted
    const alert = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.stripeEventId, eventId),
    });
    expect(alert).toBeDefined();
    expect(alert?.eventType).toBe("customer.subscription.updated");
    expect(alert?.reason).toMatch(/No tenant matched/i);

    errorSpy.mockRestore();
  });

  it("writes a stripe_alert row and logs an error when invoice.payment_failed matches no tenant", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const eventId = `evt_inv_nomatch_integ_${uid()}`;
    createdAlertEventIds.push(eventId);

    const res = await post({
      id: eventId,
      type: "invoice.payment_failed",
      data: {
        object: {
          id: `in_ghost_${uid()}`,
          customer: `cus_ghost_${uid()}`, // doesn't exist in DB
        },
      },
    });

    expect(res.status).toBe(200);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unmatched invoice.payment_failed"),
    );

    const alert = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.stripeEventId, eventId),
    });
    expect(alert).toBeDefined();
    expect(alert?.eventType).toBe("invoice.payment_failed");

    errorSpy.mockRestore();
  });

  it("triggers sendBillingAlertNotification with correct eventType, customerId, and reason when invoice.payment_failed matches no tenant", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const eventId = `evt_inv_email_${uid()}`;
    const ghostCustomerId = `cus_ghost_email_${uid()}`;
    createdAlertEventIds.push(eventId);

    vi.mocked(sendBillingAlertNotification).mockClear();

    const res = await post({
      id: eventId,
      type: "invoice.payment_failed",
      data: {
        object: {
          id: `in_ghost_email_${uid()}`,
          customer: ghostCustomerId,
        },
      },
    });

    expect(res.status).toBe(200);

    expect(sendBillingAlertNotification).toHaveBeenCalledOnce();
    expect(sendBillingAlertNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "invoice.payment_failed",
        customerId: ghostCustomerId,
        reason: expect.stringMatching(/No tenant matched/i),
      }),
    );

    errorSpy.mockRestore();
  });

  it("is idempotent: replaying the same no-match event does not create a duplicate alert", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const eventId = `evt_idem_integ_${uid()}`;
    createdAlertEventIds.push(eventId);

    const event = {
      id: eventId,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: `sub_idem_${uid()}`,
          status: "active",
          customer: `cus_idem_${uid()}`,
          metadata: {},
        },
      },
    };

    await post(event);
    const res2 = await post(event);
    expect(res2.status).toBe(200);

    const alerts = await db
      .select()
      .from(stripeAlertsTable)
      .where(eq(stripeAlertsTable.stripeEventId, eventId));

    expect(alerts).toHaveLength(1); // only one row despite two deliveries

    errorSpy.mockRestore();
  });

  it("invoice.payment_failed is idempotent: replaying the same no-match event creates exactly one alert row and notifies only once", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const eventId = `evt_inv_idem_integ_${uid()}`;
    const ghostCustomerId = `cus_inv_idem_${uid()}`;
    createdAlertEventIds.push(eventId);

    vi.mocked(sendBillingAlertNotification).mockClear();

    const event = {
      id: eventId,
      type: "invoice.payment_failed",
      data: {
        object: {
          id: `in_idem_${uid()}`,
          customer: ghostCustomerId, // doesn't exist in DB
        },
      },
    };

    // First delivery — should write the alert row and send the notification.
    const res1 = await post(event);
    expect(res1.status).toBe(200);

    // Second delivery (Stripe re-delivery of the same event).
    const res2 = await post(event);
    expect(res2.status).toBe(200);

    // Exactly one stripe_alert row despite two deliveries.
    const alerts = await db
      .select()
      .from(stripeAlertsTable)
      .where(eq(stripeAlertsTable.stripeEventId, eventId));

    expect(alerts).toHaveLength(1);
    expect(alerts[0].eventType).toBe("invoice.payment_failed");

    // Notification sent exactly once — the re-delivery must be silently skipped.
    expect(sendBillingAlertNotification).toHaveBeenCalledOnce();

    errorSpy.mockRestore();
  });
});

// ── Task #385: incomplete_expired tenant reactivation ────────────────────────
//
// An 'incomplete_expired' tenant (trial lapsed without payment) must be able
// to resubscribe via a new checkout.session.completed event.  The webhook
// handler must flip subscriptionStatus to 'active' (or 'trialing') and
// requireActiveBillingAccess must then pass.

describeIntegration("incomplete_expired tenant — reactivation via checkout.session.completed (billingTenantId metadata)", () => {
  it("flips subscriptionStatus from incomplete_expired to active on a new subscription ID", async () => {
    const subOld = `sub_ie_meta_old_${uid()}`;
    const tenantId = await createTenant({
      stripeSubscriptionId: subOld,
      subscriptionStatus: "incomplete_expired",
    });
    createdTenantIds.push(tenantId);

    const subNew = `sub_ie_meta_new_${uid()}`;
    const cusId = `cus_ie_meta_${uid()}`;

    const res = await post({
      id: `evt_ie_meta_${tenantId}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_ie_meta_${tenantId}`,
          mode: "subscription",
          customer: cusId,
          subscription: subNew, // new sub ID — this is a genuine re-subscription
          metadata: { billingTenantId: tenantId },
        },
      },
    });

    expect(res.status).toBe(200);

    const row = await getTenantBillingFields(tenantId);
    expect(["active", "trialing"]).toContain(row?.subscriptionStatus);
    expect(row?.stripeSubscriptionId).toBe(subNew);
    expect(row?.stripeCustomerId).toBe(cusId);
  });

  it("requireActiveBillingAccess passes after an incomplete_expired tenant resubscribes (billingTenantId path)", async () => {
    const { requireActiveBillingAccess } = await import("@/lib/billing");

    const subOld = `sub_ie_access_old_${uid()}`;
    const tenantId = await createTenant({
      stripeSubscriptionId: subOld,
      subscriptionStatus: "incomplete_expired",
    });
    createdTenantIds.push(tenantId);

    // Confirm the tenant is locked out before resubscribing.
    await expect(requireActiveBillingAccess(tenantId)).rejects.toThrow(
      "Subscription required",
    );

    const subNew = `sub_ie_access_new_${uid()}`;
    const cusId = `cus_ie_access_${uid()}`;

    await post({
      id: `evt_ie_access_${tenantId}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_ie_access_${tenantId}`,
          mode: "subscription",
          customer: cusId,
          subscription: subNew,
          metadata: { billingTenantId: tenantId },
        },
      },
    });

    // Billing guard must now pass.
    await expect(requireActiveBillingAccess(tenantId)).resolves.toBeUndefined();
  });
});

describeIntegration("incomplete_expired tenant — reactivation via checkout.session.completed (stripeCustomerId fallback)", () => {
  it("flips subscriptionStatus from incomplete_expired to active when matched by stripeCustomerId", async () => {
    const cusId = `cus_ie_cusid_${uid()}`;
    const subOld = `sub_ie_cusid_old_${uid()}`;

    const tenantId = await createTenant({
      stripeCustomerId: cusId,
      stripeSubscriptionId: subOld,
      subscriptionStatus: "incomplete_expired",
    });
    createdTenantIds.push(tenantId);

    const subNew = `sub_ie_cusid_new_${uid()}`;

    const res = await post({
      id: `evt_ie_cusid_${tenantId}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_ie_cusid_${tenantId}`,
          mode: "subscription",
          customer: cusId,         // matched via stripeCustomerId
          subscription: subNew,    // new sub ID — genuine re-subscription
          metadata: {},            // no billingTenantId — exercises customer-ID fallback
        },
      },
    });

    expect(res.status).toBe(200);

    const row = await getTenantBillingFields(tenantId);
    expect(["active", "trialing"]).toContain(row?.subscriptionStatus);
    expect(row?.stripeSubscriptionId).toBe(subNew);
    expect(row?.stripeCustomerId).toBe(cusId);
  });

  it("requireActiveBillingAccess passes after an incomplete_expired tenant resubscribes (stripeCustomerId path)", async () => {
    const { requireActiveBillingAccess } = await import("@/lib/billing");

    const cusId = `cus_ie_cusid_access_${uid()}`;
    const subOld = `sub_ie_cusid_access_old_${uid()}`;

    const tenantId = await createTenant({
      stripeCustomerId: cusId,
      stripeSubscriptionId: subOld,
      subscriptionStatus: "incomplete_expired",
    });
    createdTenantIds.push(tenantId);

    // Locked out before resubscribing.
    await expect(requireActiveBillingAccess(tenantId)).rejects.toThrow(
      "Subscription required",
    );

    const subNew = `sub_ie_cusid_access_new_${uid()}`;

    await post({
      id: `evt_ie_cusid_access_${tenantId}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_ie_cusid_access_${tenantId}`,
          mode: "subscription",
          customer: cusId,
          subscription: subNew,
          metadata: {},
        },
      },
    });

    // Billing guard must now pass.
    await expect(requireActiveBillingAccess(tenantId)).resolves.toBeUndefined();
  });
});

// ── checkout.session.completed — subscriptions.retrieve failure alert ─────────

describeIntegration("checkout.session.completed — subscriptions.retrieve failure", () => {
  it("persists a billing alert and notifies when subscriptions.retrieve throws", async () => {
    // A new tenant completes checkout but the retrieve call throws (e.g. key
    // mismatch). The handler must fall back to "active", log an error, AND
    // create a billing alert so the operator is notified via the panel, Slack,
    // and email — not just via log tailing.
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const subId = `sub_retrieve_fail_${uid()}`;
    const cusId = `cus_retrieve_fail_${uid()}`;
    const eventId = `evt_retrieve_fail_${uid()}`;
    createdAlertEventIds.push(eventId);

    // Make subscriptions.retrieve throw so the fallback path is exercised.
    vi.mocked(getStripeClient).mockResolvedValueOnce({
      subscriptions: {
        retrieve: vi.fn().mockRejectedValue(new Error("No such subscription: test-mode key mismatch")),
      },
    } as any);

    vi.mocked(sendBillingAlertNotification).mockClear();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await post({
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_retrieve_fail_${uid()}`,
          mode: "subscription",
          customer: cusId,
          subscription: subId,
          metadata: { billingTenantId: tenantId },
        },
      },
    });

    expect(res.status).toBe(200);

    // Tenant falls back to "active".
    const row = await getTenantBillingFields(tenantId);
    expect(row?.subscriptionStatus).toBe("active");

    // An error was logged with the subscription ID and failure reason.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(subId),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("test-mode key mismatch"),
    );

    // A billing alert row was persisted using the checkout event ID.
    const alert = await db.query.stripeAlertsTable.findFirst({
      where: eq(stripeAlertsTable.stripeEventId, eventId),
    });
    expect(alert).toBeDefined();
    expect(alert?.eventType).toBe("checkout.session.completed");
    expect(alert?.subscriptionId).toBe(subId);
    expect(alert?.reason).toMatch(/retrieve.*failed|falling back/i);

    // Email notification was sent.
    expect(sendBillingAlertNotification).toHaveBeenCalledOnce();
    expect(sendBillingAlertNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeEventId: eventId,
        subscriptionId: subId,
        reason: expect.stringContaining(subId),
      }),
    );

    errorSpy.mockRestore();
  });

  it("is idempotent: Stripe re-delivering the same event creates exactly one alert row and notifies only once", async () => {
    const tenantId = await createTenant();
    createdTenantIds.push(tenantId);

    const subId = `sub_retrieve_idem_${uid()}`;
    const cusId = `cus_retrieve_idem_${uid()}`;
    const eventId = `evt_retrieve_idem_${uid()}`;
    createdAlertEventIds.push(eventId);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(sendBillingAlertNotification).mockClear();

    const event = {
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_retrieve_idem_${uid()}`,
          mode: "subscription",
          customer: cusId,
          subscription: subId,
          metadata: { billingTenantId: tenantId },
        },
      },
    };

    // Both deliveries should fail the retrieve — supply two mock rejections.
    vi.mocked(getStripeClient)
      .mockResolvedValueOnce({
        subscriptions: { retrieve: vi.fn().mockRejectedValue(new Error("key mismatch")) },
      } as any)
      .mockResolvedValueOnce({
        subscriptions: { retrieve: vi.fn().mockRejectedValue(new Error("key mismatch")) },
      } as any);

    const res1 = await post(event);
    expect(res1.status).toBe(200);

    const res2 = await post(event);
    expect(res2.status).toBe(200);

    // Exactly one alert row.
    const alerts = await db
      .select()
      .from(stripeAlertsTable)
      .where(eq(stripeAlertsTable.stripeEventId, eventId));
    expect(alerts).toHaveLength(1);

    // Notification sent exactly once.
    expect(sendBillingAlertNotification).toHaveBeenCalledOnce();

    errorSpy.mockRestore();
  });
});
