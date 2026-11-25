/**
 * Creator configuration templates (#1689).
 *
 * Wallet-owned, versioned arena configuration templates: create, list,
 * update, clone, archive and delete, with stable ownership enforcement
 * (every query is scoped to the owning wallet, so another wallet's template
 * is simply not found).
 *
 * Concurrency: every template carries a `revision`. An update must present
 * the revision it read; a stale revision is refused with a conflict rather
 * than overwriting a concurrent edit.
 *
 * Validation: every save and every use revalidates the payload against the
 * current protocol bounds, the current registry lifecycle and the current
 * deployment capabilities, and reports the problems field by field.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";
import { apiError } from "../utils/apiError";
import { readIntegrationLifecycle, type IntegrationLifecycleState } from "./creatorTemplateLifecycle";
import {
  migrateTemplatePayload,
  validateTemplatePayload,
  TEMPLATE_SCHEMA_VERSION,
  type ArenaTemplatePayload,
  type TemplateRemediation,
} from "./arenaTemplateSchema";

export interface CreatorTemplate {
  id: string;
  name: string;
  schemaVersion: number;
  status: "active" | "archived";
  payload: ArenaTemplatePayload;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreatorTemplateWithValidation extends CreatorTemplate {
  /** Field-level problems with the stored payload, empty when it is current. */
  remediation: TemplateRemediation[];
  /** `true` when the stored payload cannot be migrated to the current schema. */
  incompatible: boolean;
}

export interface TemplateListResult {
  items: CreatorTemplateWithValidation[];
  totalCount: number;
}

export interface CreateTemplateInput {
  name: string;
  payload: ArenaTemplatePayload;
  schemaVersion?: number | undefined;
}

export interface UpdateTemplateInput {
  name?: string | undefined;
  payload?: ArenaTemplatePayload | undefined;
  /** The revision the edit was based on. */
  expectedRevision: number;
}

const TEMPLATE_STATUS_ACTIVE = "active";
const TEMPLATE_STATUS_ARCHIVED = "archived";

/** The deployment configuration a template is checked against. */
export interface DeploymentCapabilities {
  asset?: string | undefined;
  vault?: string | undefined;
  oracle?: string | undefined;
}

export class CreatorTemplateService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly capabilities: DeploymentCapabilities = {},
  ) {}

  /**
   * The lifecycle states of the integrations a template names, read from the
   * factory (#1688). A failed read leaves the map empty, which validates as
   * "active" — an unreadable registry must not invalidate a template.
   */
  private async lifecycleFor(payload: ArenaTemplatePayload): Promise<Record<string, IntegrationLifecycleState>> {
    return readIntegrationLifecycle({
      token: payload.asset,
      vault: payload.yieldVault,
      oracle: payload.oracle,
    });
  }

  private async validate(payload: ArenaTemplatePayload): Promise<TemplateRemediation[]> {
    const lifecycle = await this.lifecycleFor(payload);
    return validateTemplatePayload(payload, {
      lifecycle,
      configuredAsset: this.capabilities.asset,
      configuredVault: this.capabilities.vault,
      configuredOracle: this.capabilities.oracle,
    });
  }

  private toTemplate(row: {
    id: string;
    name: string;
    schemaVersion: number;
    status: string;
    payload: unknown;
    revision: number;
    createdAt: Date;
    updatedAt: Date;
  }): CreatorTemplate {
    return {
      id: row.id,
      name: row.name,
      schemaVersion: row.schemaVersion,
      status: row.status === TEMPLATE_STATUS_ARCHIVED ? "archived" : "active",
      payload: row.payload as ArenaTemplatePayload,
      revision: row.revision,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Migrate a stored payload to the current schema version.
   *
   * A payload from a newer schema is reported as incompatible — the
   * creator's intent is never rewritten by guesswork.
   */
  private migrate(row: {
    schemaVersion: number;
    payload: unknown;
  }): { payload: ArenaTemplatePayload | null; incompatible: boolean } {
    const raw = (row.payload ?? {}) as Record<string, unknown>;
    if (row.schemaVersion === TEMPLATE_SCHEMA_VERSION) {
      return { payload: raw as unknown as ArenaTemplatePayload, incompatible: false };
    }
    const migrated = migrateTemplatePayload(row.schemaVersion, raw);
    if (!migrated) return { payload: null, incompatible: true };
    return { payload: migrated as unknown as ArenaTemplatePayload, incompatible: false };
  }

  private async present(row: {
    id: string;
    name: string;
    schemaVersion: number;
    status: string;
    payload: unknown;
    revision: number;
    createdAt: Date;
    updatedAt: Date;
  }): Promise<CreatorTemplateWithValidation> {
    const template = this.toTemplate(row);
    const { payload, incompatible } = this.migrate(row);
    if (incompatible || !payload) {
      return { ...template, payload: (row.payload ?? {}) as ArenaTemplatePayload, remediation: [], incompatible: true };
    }
    const remediation = await this.validate(payload);
    return { ...template, payload, remediation, incompatible: false };
  }

  /** List the templates owned by a wallet. */
  async listTemplates(
    ownerAddress: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<TemplateListResult> {
    const rows = await this.prisma.creatorTemplate.findMany({
      where: {
        ownerAddress,
        ...(options.includeArchived ? {} : { status: TEMPLATE_STATUS_ACTIVE }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const items = await Promise.all(rows.map((row) => this.present(row)));
    return { items, totalCount: items.length };
  }

  /**
   * Read one template owned by a wallet.
   *
   * A template owned by another wallet is not found — the lookup is scoped
   * to the owner, so ownership can never be probed by id.
   */
  async getTemplate(ownerAddress: string, id: string): Promise<CreatorTemplateWithValidation> {
    const row = await this.prisma.creatorTemplate.findFirst({
      where: { id, ownerAddress },
    });
    if (!row) {
      throw apiError(404, "TEMPLATE_NOT_FOUND", "Template not found");
    }
    return this.present(row);
  }

  /** Create a template. Names are unique per wallet. */
  async createTemplate(
    ownerAddress: string,
    input: CreateTemplateInput,
  ): Promise<CreatorTemplateWithValidation> {
    const schemaVersion = input.schemaVersion ?? TEMPLATE_SCHEMA_VERSION;
    if (schemaVersion > TEMPLATE_SCHEMA_VERSION) {
      throw apiError(
        422,
        "TEMPLATE_SCHEMA_UNSUPPORTED",
        `This template uses schema version ${schemaVersion}, which this deployment does not support.`,
      );
    }

    const existing = await this.prisma.creatorTemplate.findFirst({
      where: { ownerAddress, name: input.name },
    });
    if (existing) {
      throw apiError(409, "TEMPLATE_NAME_TAKEN", "A template with this name already exists");
    }

    const remediation = await this.validate(input.payload);
    if (remediation.length > 0) {
      throw apiError(422, "TEMPLATE_INVALID", "The template does not satisfy the current protocol rules", {
        remediation,
      });
    }

    const row = await this.prisma.creatorTemplate.create({
      data: {
        ownerAddress,
        name: input.name,
        schemaVersion,
        status: TEMPLATE_STATUS_ACTIVE,
        payload: input.payload as unknown as Prisma.InputJsonValue,
        revision: 1,
      } as Prisma.CreatorTemplateCreateInput,
    });
    logger.info({ ownerAddress, templateId: row.id }, "creator template created");
    return this.present(row);
  }

  /**
   * Update a template.
   *
   * The expected revision must match, so a concurrent edit is never
   * silently overwritten.
   */
  async updateTemplate(
    ownerAddress: string,
    id: string,
    input: UpdateTemplateInput,
  ): Promise<CreatorTemplateWithValidation> {
    const row = await this.prisma.creatorTemplate.findFirst({ where: { id, ownerAddress } });
    if (!row) {
      throw apiError(404, "TEMPLATE_NOT_FOUND", "Template not found");
    }
    if (row.revision !== input.expectedRevision) {
      throw apiError(409, "TEMPLATE_REVISION_CONFLICT", "The template was changed by someone else; reload it and try again", {
        expectedRevision: input.expectedRevision,
        actualRevision: row.revision,
      });
    }

    if (input.name && input.name !== row.name) {
      const clash = await this.prisma.creatorTemplate.findFirst({
        where: { ownerAddress, name: input.name, id: { not: id } },
      });
      if (clash) {
        throw apiError(409, "TEMPLATE_NAME_TAKEN", "A template with this name already exists");
      }
    }

    const payload = input.payload ?? (row.payload as unknown as ArenaTemplatePayload);
    const remediation = await this.validate(payload);
    if (remediation.length > 0) {
      throw apiError(422, "TEMPLATE_INVALID", "The template does not satisfy the current protocol rules", {
        remediation,
      });
    }

    const updated = await this.prisma.creatorTemplate.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.payload
          ? { payload: input.payload as unknown as Prisma.InputJsonValue }
          : {}),
        revision: row.revision + 1,
      } as Prisma.CreatorTemplateUpdateInput,
    });
    logger.info({ ownerAddress, templateId: id, revision: updated.revision }, "creator template updated");
    return this.present(updated);
  }

  /** Clone a template under a new name. */
  async cloneTemplate(
    ownerAddress: string,
    id: string,
    name: string,
  ): Promise<CreatorTemplateWithValidation> {
    const row = await this.prisma.creatorTemplate.findFirst({ where: { id, ownerAddress } });
    if (!row) {
      throw apiError(404, "TEMPLATE_NOT_FOUND", "Template not found");
    }
    const clash = await this.prisma.creatorTemplate.findFirst({
      where: { ownerAddress, name },
    });
    if (clash) {
      throw apiError(409, "TEMPLATE_NAME_TAKEN", "A template with this name already exists");
    }
    const created = await this.prisma.creatorTemplate.create({
      data: {
        ownerAddress,
        name,
        schemaVersion: TEMPLATE_SCHEMA_VERSION,
        status: TEMPLATE_STATUS_ACTIVE,
        payload: row.payload as unknown as Prisma.InputJsonValue,
        revision: 1,
      } as Prisma.CreatorTemplateCreateInput,
    });
    logger.info({ ownerAddress, templateId: id, cloneId: created.id }, "creator template cloned");
    return this.present(created);
  }

  /** Archive or unarchive a template. */
  async setArchived(
    ownerAddress: string,
    id: string,
    archived: boolean,
  ): Promise<CreatorTemplateWithValidation> {
    const row = await this.prisma.creatorTemplate.findFirst({ where: { id, ownerAddress } });
    if (!row) {
      throw apiError(404, "TEMPLATE_NOT_FOUND", "Template not found");
    }
    const updated = await this.prisma.creatorTemplate.update({
      where: { id },
      data: {
        status: archived ? TEMPLATE_STATUS_ARCHIVED : TEMPLATE_STATUS_ACTIVE,
        revision: row.revision + 1,
      } as Prisma.CreatorTemplateUpdateInput,
    });
    logger.info({ ownerAddress, templateId: id, archived }, "creator template archived");
    return this.present(updated);
  }

  /** Delete a template. */
  async deleteTemplate(ownerAddress: string, id: string): Promise<void> {
    const row = await this.prisma.creatorTemplate.findFirst({ where: { id, ownerAddress } });
    if (!row) {
      throw apiError(404, "TEMPLATE_NOT_FOUND", "Template not found");
    }
    await this.prisma.creatorTemplate.delete({ where: { id } });
    logger.info({ ownerAddress, templateId: id }, "creator template deleted");
  }

  /**
   * Prepare a template for use in the creation form.
   *
   * The payload is revalidated against the current rules; the result
   * carries the remediation so the client can explain what the creator has
   * to fix before the template can be applied.
   */
  async prepareForUse(
    ownerAddress: string,
    id: string,
  ): Promise<CreatorTemplateWithValidation> {
    const row = await this.prisma.creatorTemplate.findFirst({ where: { id, ownerAddress } });
    if (!row) {
      throw apiError(404, "TEMPLATE_NOT_FOUND", "Template not found");
    }
    const { payload, incompatible } = this.migrate(row);
    if (incompatible || !payload) {
      throw apiError(
        422,
        "TEMPLATE_SCHEMA_UNSUPPORTED",
        "This template uses a schema version this deployment does not support and cannot be applied.",
      );
    }
    const remediation = await this.validate(payload);
    return {
      ...this.toTemplate(row),
      payload,
      remediation,
      incompatible: false,
    };
  }
}
