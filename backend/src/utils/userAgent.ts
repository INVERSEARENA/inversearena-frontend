/**
 * Best-effort, dependency-free "what device is this" label for a session
 * list (#1410). Never used for security decisions — purely a display hint,
 * so a wrong guess is cosmetic, not a vulnerability.
 */
export function describeUserAgent(userAgent: string | undefined | null): string {
  if (!userAgent) return "Unknown device";

  let browser = "Unknown browser";
  if (/Edg\//.test(userAgent)) browser = "Edge";
  else if (/OPR\//.test(userAgent)) browser = "Opera";
  else if (/Chrome\//.test(userAgent) && !/Chromium/.test(userAgent)) browser = "Chrome";
  else if (/Firefox\//.test(userAgent)) browser = "Firefox";
  else if (/Safari\//.test(userAgent) && /Version\//.test(userAgent)) browser = "Safari";

  // iPhone/iPad UAs contain the literal substring "like Mac OS X", so the
  // iOS check must run before the macOS check or every iPhone misreports as
  // a Mac.
  let os = "Unknown OS";
  if (/Windows/.test(userAgent)) os = "Windows";
  else if (/iPhone|iPad|iPod/.test(userAgent)) os = "iOS";
  else if (/Mac OS X/.test(userAgent)) os = "macOS";
  else if (/Android/.test(userAgent)) os = "Android";
  else if (/Linux/.test(userAgent)) os = "Linux";

  if (browser === "Unknown browser" && os === "Unknown OS") return "Unknown device";
  return `${browser} on ${os}`;
}
