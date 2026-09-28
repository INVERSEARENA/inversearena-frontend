"use client";

/**
 * Installs the asset-readiness telemetry destination (#1487).
 *
 * Imported once for its side effect from the wallet provider, so every gate
 * mounted anywhere in the app reports to the same place. The sink forwards to
 * Sentry as a breadcrumb rather than an exception: "a user hit a missing
 * trustline" is a product signal, not a fault, and raising it as an error
 * would page whoever watches the issue queue.
 *
 * @module
 */

import * as Sentry from "@sentry/nextjs";
import { setAssetReadinessSink } from "@/shared-d/telemetry/asset-readiness";
import { SENTRY_ENABLED } from "@/lib/sentry";

/**
 * Breadcrumbs are low-cardinality by design, so the closed label set on the
 * event becomes a tag set the Sentry UI can group by. `accountRef` is
 * deliberately *not* tagged — it is already masked, and a masked key as a tag
 * would create one group per user.
 */
setAssetReadinessSink(SENTRY_ENABLED
  ? (event) => {
      Sentry.addBreadcrumb({
        category: "asset_readiness",
        message: `${event.entryPoint}:${event.state}`,
        level: event.canProceed ? "info" : "warning",
        data: {
          entryPoint: event.entryPoint,
          state: event.state,
          assetCode: event.assetCode,
          canProceed: event.canProceed,
          reserveApproximate: event.reserveApproximate,
          network: event.network,
          accountRef: event.accountRef,
        },
      });
    }
  : null);
