/**
 * Creator configuration templates (#1689).
 *
 * A template is a named, wallet-owned bundle of arena settings that
 * prefills the creation form. Two rules shape the client side:
 *
 *  - the payload is canonical: the stake amount is stored in the asset's
 *    minor units and the asset/integrations are contract ids, so a template
 *    survives a change in display precision;
 *  - applying a template is only a suggestion: the form revalidates, the
 *    transaction preview still runs, and the balance and trustline checks
 *    are untouched.
 *
 * A template that is stale against the current protocol rules comes back
 * with field-level remediation, which the UI shows next to the template.
 */
import { POOL_TOKEN_IDS } from "@/shared/lib/stellar/stellar-transactions";
import { stellarConfig } from "@/shared/config/stellarConfig";
import type { Currency } from "@/shared/lib/form-validation";
import type { RoundSpeed } from "./pool-schema";

/** The payload schema version this client writes (#1689). */
export const TEMPLATE_SCHEMA_VERSION = 1;

/** Decimals of the assets the creation form offers. */
export const TEMPLATE_ASSET_DECIMALS = 7;

/** The canonical payload of a template. */
export interface ArenaTemplatePayload {
  stakeAmountMinor: string;
  assetDecimals: number;
  asset: string;
  capacity: number;
  roundSpeed: RoundSpeed;
  roundDurationSeconds: number;
  startDeadlineSeconds?: number;
  yieldVault?: string | undefined;
  oracle?: string | undefined;
  metadata?: Record<string, string> | undefined;
}

/** One field-level problem with a template. */
export interface TemplateRemediation {
  field: string;
  code: string;
  message: string;
}

/** A template as the API returns it. */
export interface ArenaTemplate {
  id: string;
  name: string;
  schemaVersion: number;
  status: "active" | "archived";
  payload: ArenaTemplatePayload;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Field-level problems; empty when the template satisfies the current rules. */
  remediation: TemplateRemediation[];
  /** `true` when the stored payload cannot be migrated to the current schema. */
  incompatible: boolean;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

/**
 * The access token of the signed-in creator.
 *
 * The templates API is wallet-authenticated. When no token is stored the
 * UI shows its signed-out state instead of failing every request.
 */
export function readAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem("arena.accessToken");
  } catch {
    return null;
  }
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = readAccessToken();
  const response = await fetch(`${API_BASE}/api/creator/templates${path}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string; details?: { remediation?: TemplateRemediation[] } } }
      | null;
    const error = new Error(body?.error?.message ?? `Request failed (${response.status})`);
    (error as Error & { code?: string; remediation?: TemplateRemediation[] }).code =
      body?.error?.code ?? "REQUEST_FAILED";
    (error as Error & { code?: string; remediation?: TemplateRemediation[] }).remediation =
      body?.error?.details?.remediation ?? [];
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** The templates owned by the signed-in creator. */
export async function listTemplates(includeArchived = false): Promise<ArenaTemplate[]> {
  const result = await request<{ items: ArenaTemplate[] }>(
    includeArchived ? "?includeArchived=true" : "",
  );
  return result.items ?? [];
}

/** Save the current configuration as a template. */
export async function createTemplate(
  name: string,
  payload: ArenaTemplatePayload,
): Promise<ArenaTemplate> {
  return request<ArenaTemplate>("", {
    method: "POST",
    body: { name, payload, schemaVersion: TEMPLATE_SCHEMA_VERSION },
  });
}

/** Update a template. The revision guards against concurrent edits. */
export async function updateTemplate(
  id: string,
  changes: { name?: string; payload?: ArenaTemplatePayload },
  expectedRevision: number,
): Promise<ArenaTemplate> {
  return request<ArenaTemplate>(`/${id}`, {
    method: "PATCH",
    body: { ...changes, expectedRevision },
  });
}

/** Clone a template under a new name. */
export async function cloneTemplate(id: string, name: string): Promise<ArenaTemplate> {
  return request<ArenaTemplate>(`/${id}/clone`, { method: "POST", body: { name } });
}

/** Archive or unarchive a template. */
export async function setTemplateArchived(
  id: string,
  archived: boolean,
): Promise<ArenaTemplate> {
  return request<ArenaTemplate>(`/${id}/archive`, { method: "POST", body: { archived } });
}

/** Delete a template. */
export async function deleteTemplate(id: string): Promise<void> {
  await request<void>(`/${id}`, { method: "DELETE" });
}

/** The form values a template maps onto. */
export interface TemplateFormValues {
  stakeAmountInput: string;
  currency: Currency;
  roundSpeed: RoundSpeed;
  arenaCapacity: number;
}

/** The round duration each round speed implies, in seconds. */
export const ROUND_SPEED_SECONDS: Record<RoundSpeed, number> = {
  "30S": 30,
  "1M": 60,
  "5M": 300,
};

/**
 * The canonical payload for the current form values.
 *
 * The stake amount is converted to the asset's minor units — the template
 * never stores "100 USDC", only `100000000` and the asset's decimals.
 */
export function toTemplatePayload(values: TemplateFormValues): ArenaTemplatePayload {
  const decimals = TEMPLATE_ASSET_DECIMALS;
  const amount = Number.parseFloat(values.stakeAmountInput);
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  return {
    stakeAmountMinor: Math.round(safeAmount * 10 ** decimals).toString(),
    assetDecimals: decimals,
    asset: POOL_TOKEN_IDS[values.currency],
    capacity: values.arenaCapacity,
    roundSpeed: values.roundSpeed,
    roundDurationSeconds: ROUND_SPEED_SECONDS[values.roundSpeed],
    yieldVault: stellarConfig.rwaVaultContractId,
    oracle: stellarConfig.oracleContractId,
  };
}

/**
 * The form values a template maps onto.
 *
 * A template whose asset is not one of the offered currencies cannot be
 * applied — the currency is unknown, so the caller is told rather than
 * silently applied to the wrong asset.
 */
export function applyTemplateToForm(
  payload: ArenaTemplatePayload,
): { values: TemplateFormValues; error?: string } {
  const currency = (Object.keys(POOL_TOKEN_IDS) as Currency[]).find(
    (candidate) => POOL_TOKEN_IDS[candidate] === payload.asset,
  );
  if (!currency) {
    return {
      values: { stakeAmountInput: "0", currency: "USDC", roundSpeed: payload.roundSpeed, arenaCapacity: payload.capacity },
      error: "This template uses an asset the creation form does not offer.",
    };
  }
  const minor = Number.parseInt(payload.stakeAmountMinor || "0", 10);
  const amount = Number.isFinite(minor) ? minor / 10 ** (payload.assetDecimals ?? TEMPLATE_ASSET_DECIMALS) : 0;
  return {
    values: {
      stakeAmountInput: String(amount),
      currency,
      roundSpeed: payload.roundSpeed,
      arenaCapacity: payload.capacity,
    },
  };
}
