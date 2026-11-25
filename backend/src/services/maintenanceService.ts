import {
  MaintenanceWindowModel,
  type MaintenanceWindowDocument,
} from "../db/models/maintenanceWindow.model";
import { apiError } from "../utils/apiError";
import { getCurrentLedgerSequence } from "./ledgerClock";

export type MaintenanceStatus = "scheduled" | "active" | "completed" | "cancelled";

export interface MaintenanceWindowView {
  id: string;
  scheduledBy: string;
  startLedgerSequence: number;
  endLedgerSequence: number | null;
  reason: string;
  status: MaintenanceStatus;
  cancelledAt: string | null;
  createdAt: string;
}

export interface MaintenanceStatusView {
  active: boolean;
  currentLedgerSequence: number;
  window: MaintenanceWindowView | null;
}

/**
 * DESIGN NOTE (#1399)
 *
 * Ownership: MaintenanceService owns the ledger-boundary state machine for a
 * maintenance window. AdminController owns *who* may schedule/cancel one
 * (confirmation-token + audit-log, matching every other destructive admin
 * action) — this service has no opinion on authorization.
 *
 * State transitions (pure, derived — never persisted):
 *   scheduled -> active     when currentLedger >= startLedgerSequence
 *   active    -> completed  when endLedgerSequence is set and
 *                            currentLedger >= endLedgerSequence
 *   (any)     -> cancelled  terminal, set explicitly via cancel()
 * An indefinite window (endLedgerSequence === null) never auto-completes; it
 * must be cancelled. Status is computed fresh on every read from
 * (startLedgerSequence, endLedgerSequence, cancelledAt, currentLedger)
 * instead of being written by a background job — there is no cron/worker
 * that can fall behind, double-fire, or race a concurrent cancel.
 *
 * Compatibility: GET /api/maintenance/status is public and unauthenticated
 * (reads must keep working during a maintenance window, including for
 * anonymous callers deciding whether to even attempt a mutation) and is
 * additive — no existing endpoint's shape changes.
 */
export function deriveMaintenanceStatus(
  window: Pick<
    MaintenanceWindowDocument,
    "startLedgerSequence" | "endLedgerSequence" | "cancelledAt"
  >,
  currentLedgerSequence: number,
): MaintenanceStatus {
  if (window.cancelledAt) return "cancelled";
  if (currentLedgerSequence < window.startLedgerSequence) return "scheduled";
  if (window.endLedgerSequence !== null && currentLedgerSequence >= window.endLedgerSequence) {
    return "completed";
  }
  return "active";
}

function toView(doc: MaintenanceWindowDocument, currentLedgerSequence: number): MaintenanceWindowView {
  return {
    id: String(doc._id),
    scheduledBy: doc.scheduledBy,
    startLedgerSequence: doc.startLedgerSequence,
    endLedgerSequence: doc.endLedgerSequence,
    reason: doc.reason,
    status: deriveMaintenanceStatus(doc, currentLedgerSequence),
    cancelledAt: doc.cancelledAt ? doc.cancelledAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
  };
}

export class MaintenanceService {
  async schedule(input: {
    scheduledBy: string;
    startLedgerSequence: number;
    endLedgerSequence: number | null;
    reason: string;
  }): Promise<MaintenanceWindowView> {
    if (
      input.endLedgerSequence !== null &&
      input.endLedgerSequence <= input.startLedgerSequence
    ) {
      throw apiError(
        400,
        "INVALID_WINDOW",
        "endLedgerSequence must be greater than startLedgerSequence",
      );
    }

    const currentLedgerSequence = await getCurrentLedgerSequence();
    if (input.startLedgerSequence < currentLedgerSequence) {
      throw apiError(
        400,
        "INVALID_WINDOW",
        `startLedgerSequence must not be in the past (current ledger is ${currentLedgerSequence})`,
      );
    }

    const doc = await MaintenanceWindowModel.create({
      scheduledBy: input.scheduledBy,
      startLedgerSequence: input.startLedgerSequence,
      endLedgerSequence: input.endLedgerSequence,
      reason: input.reason,
    });

    return toView(doc, currentLedgerSequence);
  }

  async cancel(id: string, cancelledBy: string): Promise<MaintenanceWindowView> {
    const doc = await MaintenanceWindowModel.findById(id);
    if (!doc) {
      throw apiError(404, "NOT_FOUND", "Maintenance window not found");
    }

    const currentLedgerSequence = await getCurrentLedgerSequence();
    const status = deriveMaintenanceStatus(doc, currentLedgerSequence);
    if (status === "cancelled" || status === "completed") {
      throw apiError(409, "CONFLICT", `Maintenance window is already ${status}`);
    }

    doc.cancelledAt = new Date();
    doc.cancelledBy = cancelledBy;
    await doc.save();

    return toView(doc, currentLedgerSequence);
  }

  async list(): Promise<MaintenanceWindowView[]> {
    const [docs, currentLedgerSequence] = await Promise.all([
      MaintenanceWindowModel.find().sort({ createdAt: -1 }).limit(100),
      getCurrentLedgerSequence(),
    ]);
    return docs.map((doc) => toView(doc, currentLedgerSequence));
  }

  private async activeWindowAt(currentLedgerSequence: number): Promise<MaintenanceWindowView | null> {
    // Only windows whose start has already passed can possibly be active —
    // narrowing here keeps the derivation check below cheap even with a long
    // scheduling history.
    const candidates = await MaintenanceWindowModel.find({
      cancelledAt: null,
      startLedgerSequence: { $lte: currentLedgerSequence },
    }).sort({ createdAt: -1 });

    for (const doc of candidates) {
      if (deriveMaintenanceStatus(doc, currentLedgerSequence) === "active") {
        return toView(doc, currentLedgerSequence);
      }
    }
    return null;
  }

  /**
   * The single source of truth for both the public status endpoint and the
   * mutation-blocking guard — both must agree on what "active" means at this
   * instant, so they share this method rather than each deriving it.
   */
  async getStatus(): Promise<MaintenanceStatusView> {
    const currentLedgerSequence = await getCurrentLedgerSequence();
    const window = await this.activeWindowAt(currentLedgerSequence);
    return { active: window !== null, currentLedgerSequence, window };
  }
}
