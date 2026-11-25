import React, { ReactElement } from "react";
import { render, RenderOptions, RenderResult } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "@/i18n/messages/en.json";

/**
 * Render a component tree inside the next-intl provider with the English
 * catalog, so `useTranslations`/`getTranslations` resolve in jsdom (#1575).
 */
export function renderWithIntl(ui: ReactElement, options?: RenderOptions): RenderResult {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
    options,
  );
}
