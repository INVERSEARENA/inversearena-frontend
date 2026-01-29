"use client";

import React, { ErrorInfo } from "react";
import { useRouter } from "next/navigation";

interface ErrorFallbackProps {
  error: Error | null;
  errorInfo: ErrorInfo | null;
  onReset: () => void;
}

/**
 * Error Fallback UI Component
 * 
 * Displays a user-friendly error screen with recovery actions.
 * Matches the app's design system with dark theme and neon-green accents.
 */
export function ErrorFallback({
  error,
  errorInfo,
  onReset,
}: ErrorFallbackProps) {
  const router = useRouter();
  const [copied, setCopied] = React.useState(false);

  const handleGoHome = () => {
    onReset();
    router.push("/");
  };

  const handleRetry = () => {
    onReset();
  };

  const handleReportIssue = () => {
    const errorDetails = `
Error: ${error?.message || "Unknown error"}

Stack Trace:
${error?.stack || "No stack trace available"}

Component Stack:
${errorInfo?.componentStack || "No component stack available"}

User Agent: ${navigator.userAgent}
Timestamp: ${new Date().toISOString()}
    `.trim();

    navigator.clipboard.writeText(errorDetails).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="max-w-2xl w-full">
        {/* Error Icon */}
        <div className="flex justify-center mb-8">
          <div className="relative">
            <div className="w-24 h-24 border-4 border-red-500 rounded-lg flex items-center justify-center animate-pulse">
              <span className="text-5xl text-red-500">⚠</span>
            </div>
            <div className="absolute -top-2 -right-2 w-8 h-8 bg-neon-green rounded-full animate-ping"></div>
          </div>
        </div>

        {/* Error Message */}
        <div className="text-center mb-8">
          <h1 className="font-pixel text-2xl md:text-4xl text-neon-green mb-4 uppercase tracking-wider">
            System Error
          </h1>
          <p className="text-gray-400 text-lg mb-2">
            Something went wrong in the arena
          </p>
          <p className="text-gray-500 text-sm">
            Don't worry, your data is safe. Try one of the recovery options below.
          </p>
        </div>

        {/* Error Details (Collapsed by default) */}
        <details className="mb-8 bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <summary className="cursor-pointer p-4 hover:bg-gray-800 transition-colors text-gray-400 font-mono text-sm">
            View Technical Details
          </summary>
          <div className="p-4 border-t border-gray-800 bg-black">
            <div className="mb-4">
              <p className="text-red-400 font-mono text-xs mb-2">Error Message:</p>
              <p className="text-gray-300 font-mono text-xs bg-gray-900 p-3 rounded break-all">
                {error?.message || "Unknown error occurred"}
              </p>
            </div>
            {error?.stack && (
              <div>
                <p className="text-red-400 font-mono text-xs mb-2">Stack Trace:</p>
                <pre className="text-gray-400 font-mono text-xs bg-gray-900 p-3 rounded overflow-x-auto max-h-48 overflow-y-auto">
                  {error.stack}
                </pre>
              </div>
            )}
          </div>
        </details>

        {/* Recovery Actions */}
        <div className="space-y-4">
          {/* Retry Button */}
          <button
            onClick={handleRetry}
            className="w-full bg-neon-green text-black font-pixel py-4 px-6 rounded-lg hover:bg-neon-green/90 transition-all transform hover:scale-105 uppercase tracking-wider text-sm focus:outline-none focus:ring-2 focus:ring-neon-green focus:ring-offset-2 focus:ring-offset-black"
            aria-label="Retry and attempt to reload the component"
          >
            🔄 Retry
          </button>

          {/* Go Home Button */}
          <button
            onClick={handleGoHome}
            className="w-full bg-gray-800 text-white font-pixel py-4 px-6 rounded-lg hover:bg-gray-700 transition-all border border-gray-700 uppercase tracking-wider text-sm focus:outline-none focus:ring-2 focus:ring-gray-600 focus:ring-offset-2 focus:ring-offset-black"
            aria-label="Navigate back to the home page"
          >
            🏠 Go Home
          </button>

          {/* Report Issue Button */}
          <button
            onClick={handleReportIssue}
            className="w-full bg-transparent text-gray-400 font-pixel py-4 px-6 rounded-lg hover:bg-gray-900 transition-all border border-gray-800 uppercase tracking-wider text-sm focus:outline-none focus:ring-2 focus:ring-gray-700 focus:ring-offset-2 focus:ring-offset-black relative"
            aria-label="Copy error details to clipboard for reporting"
          >
            📋 {copied ? "Copied!" : "Report Issue"}
            {copied && (
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-neon-green text-xs">
                ✓
              </span>
            )}
          </button>
        </div>

        {/* Additional Help Text */}
        <p className="text-center text-gray-600 text-xs mt-6 font-mono">
          If the problem persists, please contact support
        </p>
      </div>
    </div>
  );
}
