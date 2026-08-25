import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import AdminDashboardPage from "../page";

const replaceMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

const useWalletMock = jest.fn();
jest.mock("@/features/wallet/useWallet", () => ({
  useWallet: () => useWalletMock(),
}));

const useAdminRoleMock = jest.fn();
jest.mock("@/features/wallet/useAdminRole", () => ({
  useAdminRole: (publicKey: string | null) => useAdminRoleMock(publicKey),
}));

jest.mock("@/components/modals/PoolCreationModal", () => ({
  PoolCreationModal: () => null,
}));

const CONNECTED_ADDRESS =
  "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

describe("AdminDashboardPage authorization gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("redirects to / when the wallet is disconnected", () => {
    useWalletMock.mockReturnValue({ status: "disconnected", publicKey: null });
    useAdminRoleMock.mockReturnValue("idle");

    render(<AdminDashboardPage />);

    expect(replaceMock).toHaveBeenCalledWith("/");
  });

  it("does not render admin controls for a merely-connected wallet that fails the server role check", async () => {
    useWalletMock.mockReturnValue({ status: "connected", publicKey: CONNECTED_ADDRESS });
    useAdminRoleMock.mockReturnValue("unauthorized");

    render(<AdminDashboardPage />);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/"));
    expect(screen.queryByText(/ADMIN DASHBOARD/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/CREATE ARENA/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/RESOLVE ROUND/i)).not.toBeInTheDocument();
  });

  it("treats a failed role-check request as unauthorized and redirects", async () => {
    useWalletMock.mockReturnValue({ status: "connected", publicKey: CONNECTED_ADDRESS });
    useAdminRoleMock.mockReturnValue("error");

    render(<AdminDashboardPage />);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/"));
    expect(screen.queryByText(/ADMIN DASHBOARD/i)).not.toBeInTheDocument();
  });

  it("shows a verifying state and does not redirect while the role check is in flight", () => {
    useWalletMock.mockReturnValue({ status: "connected", publicKey: CONNECTED_ADDRESS });
    useAdminRoleMock.mockReturnValue("checking");

    render(<AdminDashboardPage />);

    expect(replaceMock).not.toHaveBeenCalled();
    expect(screen.getByText(/VERIFYING ACCESS/i)).toBeInTheDocument();
    expect(screen.queryByText(/ADMIN DASHBOARD/i)).not.toBeInTheDocument();
  });

  it("renders admin controls once the server confirms the wallet is an authorized admin", async () => {
    useWalletMock.mockReturnValue({ status: "connected", publicKey: CONNECTED_ADDRESS });
    useAdminRoleMock.mockReturnValue("authorized");

    render(<AdminDashboardPage />);

    expect(replaceMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/ADMIN DASHBOARD/i)).toBeInTheDocument();
  });
});
