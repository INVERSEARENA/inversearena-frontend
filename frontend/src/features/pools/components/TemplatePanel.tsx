"use client";

import { useCallback, useEffect, useState } from "react";
import {
  applyTemplateToForm,
  cloneTemplate,
  createTemplate,
  deleteTemplate,
  listTemplates,
  setTemplateArchived,
  toTemplatePayload,
  type ArenaTemplate,
  type TemplateFormValues,
} from "@/features/pools/model/arena-templates";

interface TemplatePanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** The current form values, used when saving a template. */
  currentValues: TemplateFormValues;
  /** Called when the creator applies a template to the form. */
  onApply: (values: TemplateFormValues) => void;
}

/**
 * The creator's template list (#1689).
 *
 * Applying a template only prefills the form: the form's own validation,
 * the transaction preview and the balance/trustline checks all still run
 * afterwards. A template that is stale against the current rules is shown
 * with its field-level remediation instead of being applied silently.
 */
export function TemplatePanel({
  isOpen,
  onClose,
  currentValues,
  onApply,
}: TemplatePanelProps) {
  const [templates, setTemplates] = useState<ArenaTemplate[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [templateName, setTemplateName] = useState<string>("");
  const [busyId, setBusyId] = useState<string>("");

  const refresh = useCallback(async () => {
    setStatus("loading");
    try {
      const items = await listTemplates(true);
      setTemplates(items);
      setStatus("idle");
      setErrorMessage("");
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "Templates could not be loaded");
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void refresh();
  }, [isOpen, refresh]);

  if (!isOpen) return null;

  async function run(templateId: string, action: () => Promise<void>) {
    setBusyId(templateId);
    setErrorMessage("");
    try {
      await action();
      await refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The template action failed");
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="rounded-2xl border-3 border-black bg-[#0d1526] p-4 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-black uppercase tracking-[0.2em] text-white">Arena templates</p>
        <button type="button" onClick={onClose} className="text-xs font-bold uppercase text-slate-400 hover:text-white">
          Close
        </button>
      </div>

      {/* Save the current configuration as a template. */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={templateName}
          onChange={(event) => setTemplateName(event.target.value)}
          placeholder="Template name"
          maxLength={80}
          className="flex-1 rounded-xl border-2 border-black bg-[#1e293b] px-3 py-2 text-sm text-white"
        />
        <button
          type="button"
          disabled={templateName.trim().length === 0}
          onClick={() =>
            void run("", async () => {
              await createTemplate(templateName.trim(), toTemplatePayload(currentValues));
              setTemplateName("");
            })
          }
          className="rounded-xl border-3 border-black bg-primary px-4 py-2 text-xs font-black uppercase text-black disabled:opacity-50"
        >
          Save current
        </button>
      </div>

      {status === "loading" && (
        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Loading templates…</p>
      )}

      {status === "error" && (
        <p className="rounded-xl border border-red-500/30 bg-red-900/50 p-3 text-xs text-red-200">
          {errorMessage}
        </p>
      )}

      {status === "idle" && templates.length === 0 && (
        <p className="text-xs text-slate-400">
          No templates yet. Save the current configuration to reuse it later.
        </p>
      )}

      <ul className="space-y-2">
        {templates.map((template) => (
          <li key={template.id} className="rounded-xl border border-white/10 bg-black/30 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-bold text-white">
                {template.name}
                {template.status === "archived" && (
                  <span className="ml-2 text-[10px] uppercase tracking-[0.2em] text-slate-400">archived</span>
                )}
              </p>
              <span className="text-[10px] uppercase tracking-[0.2em] text-slate-500">
                v{template.schemaVersion} · rev {template.revision}
              </span>
            </div>

            {template.incompatible && (
              <p className="rounded-lg border border-amber-400/30 bg-amber-950/40 p-2 text-xs text-amber-200">
                This template was written for a newer configuration format and cannot be applied. Save a new
                template from the current form instead.
              </p>
            )}

            {template.remediation.length > 0 && (
              <ul className="space-y-1">
                {template.remediation.map((item) => (
                  <li key={`${item.field}-${item.code}`} className="text-xs text-amber-200">
                    <span className="font-bold uppercase">{item.field}</span>: {item.message}
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busyId === template.id || template.incompatible}
                onClick={() => void run(template.id, async () => {
                  const { values, error } = applyTemplateToForm(template.payload);
                  if (error) throw new Error(error);
                  onApply(values);
                })}
                className="rounded-lg border-2 border-black bg-primary px-3 py-1 text-[10px] font-black uppercase text-black disabled:opacity-50"
              >
                Apply
              </button>
              <button
                type="button"
                disabled={busyId === template.id}
                onClick={() => void run(template.id, async () => {
                  await cloneTemplate(template.id, `${template.name} copy`);
                })}
                className="rounded-lg border-2 border-black bg-[#1e293b] px-3 py-1 text-[10px] font-black uppercase text-white disabled:opacity-50"
              >
                Clone
              </button>
              <button
                type="button"
                disabled={busyId === template.id}
                onClick={() => void run(template.id, async () => {
                  await setTemplateArchived(template.id, template.status !== "archived");
                })}
                className="rounded-lg border-2 border-black bg-[#1e293b] px-3 py-1 text-[10px] font-black uppercase text-white disabled:opacity-50"
              >
                {template.status === "archived" ? "Restore" : "Archive"}
              </button>
              <button
                type="button"
                disabled={busyId === template.id}
                onClick={() => void run(template.id, async () => {
                  await deleteTemplate(template.id);
                })}
                className="rounded-lg border-2 border-black bg-[#1e293b] px-3 py-1 text-[10px] font-black uppercase text-red-300 disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      {errorMessage && status !== "error" && (
        <p className="rounded-xl border border-red-500/30 bg-red-900/50 p-3 text-xs text-red-200">{errorMessage}</p>
      )}
    </div>
  );
}
