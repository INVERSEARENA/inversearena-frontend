/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { ErrorFallback } from "../ErrorFallback";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

function withNodeEnv(value: string, fn: () => void): void {
  const original = process.env.NODE_ENV;
  Object.defineProperty(process.env, "NODE_ENV", { value, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process.env, "NODE_ENV", { value: original, configurable: true });
  }
}

const testError = new Error("Something exploded in useWallet.ts");
testError.stack = "Error: Something exploded in useWallet.ts\n    at useWallet (/app/src/features/wallet/useWallet.ts:42:11)";

describe("ErrorFallback — technical details visibility (issue #1287)", () => {
  it("hides the 'View Technical Details' section in production", () => {
    withNodeEnv("production", () => {
      render(<ErrorFallback error={testError} />);
      expect(screen.queryByText("View Technical Details")).not.toBeInTheDocument();
    });
  });

  it("does not leak the error message or stack trace text into the DOM in production", () => {
    withNodeEnv("production", () => {
      render(<ErrorFallback error={testError} />);
      expect(screen.queryByText(/Something exploded in useWallet\.ts/)).not.toBeInTheDocument();
      expect(screen.queryByText(/useWallet\.ts:42:11/)).not.toBeInTheDocument();
    });
  });

  it("shows the 'View Technical Details' section outside production (development)", () => {
    withNodeEnv("development", () => {
      render(<ErrorFallback error={testError} />);
      expect(screen.getByText("View Technical Details")).toBeInTheDocument();
    });
  });

  it("shows the 'View Technical Details' section in test environment", () => {
    withNodeEnv("test", () => {
      render(<ErrorFallback error={testError} />);
      expect(screen.getByText("View Technical Details")).toBeInTheDocument();
    });
  });

  it("still renders the Report Issue button in production (clipboard path is unaffected)", () => {
    withNodeEnv("production", () => {
      render(<ErrorFallback error={testError} />);
      expect(screen.getByLabelText("Copy error details to clipboard for reporting")).toBeInTheDocument();
    });
  });
});
