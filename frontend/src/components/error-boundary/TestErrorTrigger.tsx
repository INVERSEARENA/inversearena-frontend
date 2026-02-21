"use client";

import { useState } from "react";

/**
 * Test component to trigger errors for testing the Error Boundary
 * 
 * Usage: Import and add to any page temporarily to test error handling
 * Example: <TestErrorTrigger />
 * 
 * REMOVE THIS FROM PRODUCTION CODE
 */
export function TestErrorTrigger() {
  const [shouldThrow, setShouldThrow] = useState(false);

  if (shouldThrow) {
    // This will be caught by the Error Boundary
    throw new Error("Test error: This is a simulated error for testing the Error Boundary!");
  }

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <button
        onClick={() => setShouldThrow(true)}
        className="bg-red-500 text-white px-4 py-2 rounded-lg font-mono text-xs hover:bg-red-600 transition-colors"
      >
        🧪 Trigger Test Error
      </button>
    </div>
  );
}
