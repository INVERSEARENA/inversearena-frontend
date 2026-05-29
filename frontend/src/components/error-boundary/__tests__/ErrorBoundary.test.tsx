/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "../ErrorBoundary";
import { TestErrorTrigger } from "../TestErrorTrigger";

// Suppress console.error noise from intentional throws in tests
beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "group").mockImplementation(() => {});
  jest.spyOn(console, "groupEnd").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Mock next/navigation used by ErrorFallback
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

// Mock Sentry so tests don't need a real DSN
jest.mock("@/lib/sentry", () => ({
  captureReactError: jest.fn(),
}));

function ThrowOnMount({ message = "test error" }: { message?: string }): never {
  throw new Error(message);
}

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>
    );
    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  it("catches a render error and shows the default fallback", () => {
    render(
      <ErrorBoundary>
        <ThrowOnMount />
      </ErrorBoundary>
    );
    expect(screen.getByText(/system error/i)).toBeInTheDocument();
  });

  it("shows a custom fallback when provided", () => {
    render(
      <ErrorBoundary fallback={<p>Custom fallback</p>}>
        <ThrowOnMount />
      </ErrorBoundary>
    );
    expect(screen.getByText("Custom fallback")).toBeInTheDocument();
  });

  it("shows context-specific message in ErrorFallback", () => {
    const { ErrorFallback } = require("../ErrorFallback");
    render(
      <ErrorBoundary fallback={<ErrorFallback context="arena" />}>
        <ThrowOnMount />
      </ErrorBoundary>
    );
    expect(
      screen.getByText(/something went wrong loading the arena/i)
    ).toBeInTheDocument();
  });

  it("calls onError prop when an error is caught", () => {
    const onError = jest.fn();
    render(
      <ErrorBoundary onError={onError}>
        <ThrowOnMount message="boom" />
      </ErrorBoundary>
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][0].message).toBe("boom");
  });

  it("resets the boundary when the retry button is clicked", () => {
    render(
      <ErrorBoundary>
        <TestErrorTrigger />
      </ErrorBoundary>
    );

    // Trigger the error
    fireEvent.click(screen.getByRole("button", { name: /trigger test error/i }));
    expect(screen.getByText(/system error/i)).toBeInTheDocument();

    // Click retry — boundary resets; TestErrorTrigger re-mounts without throwing
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(screen.queryByText(/system error/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /trigger test error/i })).toBeInTheDocument();
  });

  it("TestErrorTrigger throws when button is clicked", () => {
    render(
      <ErrorBoundary>
        <TestErrorTrigger />
      </ErrorBoundary>
    );

    fireEvent.click(screen.getByRole("button", { name: /trigger test error/i }));

    expect(screen.getByText(/system error/i)).toBeInTheDocument();
  });
});
