import { fireEvent, render, screen } from "@testing-library/react";
import { NotificationChannelSettings } from "../NotificationChannelSettings";
import { useNotificationChannels } from "../../hooks/useNotificationChannels";

jest.mock("../../hooks/useNotificationChannels", () => ({
  NOTIFICATION_EVENTS: ["round", "payout", "elimination", "rematch", "arena_announcement"],
  USER_NOTIFICATION_CHANNELS: ["push", "telegram", "discord", "in_app"],
  useNotificationChannels: jest.fn(),
}));

const mockedHook = useNotificationChannels as jest.Mock;

const baseData = {
  preferences: {
    userId: "user-1",
    emailEnabled: false,
    pushEnabled: true,
    telegramEnabled: false,
    discordEnabled: false,
    inAppEnabled: true,
    roundNotifications: true,
    payoutNotifications: true,
    eliminationNotifications: true,
    arenaAnnouncementNotifications: true,
  },
  channelPreferences: [],
  links: [],
};

const baseReturn = {
  data: baseData,
  loading: false,
  error: null,
  linkCode: null,
  refresh: jest.fn(),
  updateSettings: jest.fn(),
  setChannelEvent: jest.fn(),
  createLinkCode: jest.fn(),
  unlink: jest.fn(),
};

describe("NotificationChannelSettings (#1735)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedHook.mockReturnValue(baseReturn);
  });

  it("renders the per-event/per-channel matrix with legacy defaults", () => {
    render(<NotificationChannelSettings />);

    const pushRound = screen.getByLabelText("ROUND PHASES via WEB PUSH");
    const telegramRound = screen.getByLabelText("ROUND PHASES via TELEGRAM");
    expect(pushRound).toBeChecked();
    expect(telegramRound).not.toBeChecked();
  });

  it("uses explicit overrides and persists checkbox changes", () => {
    mockedHook.mockReturnValue({
      ...baseReturn,
      data: {
        ...baseData,
        channelPreferences: [{ eventType: "payout", channel: "telegram", enabled: true }],
      },
    });

    render(<NotificationChannelSettings />);
    const checkbox = screen.getByLabelText("PAYOUTS via TELEGRAM");
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);
    expect(baseReturn.setChannelEvent).toHaveBeenCalledWith("payout", "telegram", false);
  });

  it("creates a bot link code and shows the one-time code", () => {
    mockedHook.mockReturnValue({
      ...baseReturn,
      linkCode: {
        channel: "telegram",
        code: "ABC12345",
        expiresAt: "2026-11-20T12:10:00.000Z",
        instructions: "Send /start ABC12345 to the InverseArena Telegram bot.",
      },
    });

    render(<NotificationChannelSettings />);
    fireEvent.click(screen.getByRole("button", { name: "LINK TELEGRAM" }));

    expect(baseReturn.createLinkCode).toHaveBeenCalledWith("telegram");
    expect(screen.getByText(/CODE: ABC12345/)).toBeInTheDocument();
  });
});
