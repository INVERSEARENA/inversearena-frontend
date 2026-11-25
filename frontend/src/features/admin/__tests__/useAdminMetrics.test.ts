// Tests for useAdminMetrics hook

import { renderHook, waitFor } from "@testing-library/react";
import { useAdminMetrics } from "../hooks/useAdminMetrics";
import * as adminApi from "../api/adminApi";

jest.mock("../api/adminApi");

describe("useAdminMetrics", () => {
  const mockMetrics = {
    totalArenas: 100,
    activeArenas: 75,
    totalPlayers: 5000,
    activePlayers: 3000,
    totalVolume: 10_000_000,
    platformFees: 50_000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should fetch metrics on mount", async () => {
    (adminApi.fetchAdminMetrics as jest.Mock).mockResolvedValue(mockMetrics);

    const { result } = renderHook(() => useAdminMetrics());

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.metrics).toEqual(mockMetrics);
    expect(result.current.error).toBeNull();
  });

  it("should handle errors", async () => {
    const mockError = new Error("Failed to fetch metrics");
    (adminApi.fetchAdminMetrics as jest.Mock).mockRejectedValue(mockError);

    const { result } = renderHook(() => useAdminMetrics());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.metrics).toBeNull();
    expect(result.current.error).toEqual(mockError);
  });

  it("should refetch metrics when refetch is called", async () => {
    (adminApi.fetchAdminMetrics as jest.Mock).mockResolvedValue(mockMetrics);

    const { result } = renderHook(() => useAdminMetrics());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const updatedMetrics = { ...mockMetrics, totalArenas: 150 };
    (adminApi.fetchAdminMetrics as jest.Mock).mockResolvedValue(updatedMetrics);

    await result.current.refetch();

    await waitFor(() => {
      expect(result.current.metrics).toEqual(updatedMetrics);
    });
  });
});
