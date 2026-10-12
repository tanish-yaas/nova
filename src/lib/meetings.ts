/**
 * Meetings, as Nova models them.
 *
 * A meeting is a calendar event with people on it. There is no separate
 * table: the event already carries a place (location), a link (meetingUrl)
 * and attendee rows, and the one thing that marks it as a meeting rather
 * than a plain event is an organizer row among its attendees. A plain event
 * ("Leave", "Launch day") never gets attendee rows, so the two cannot be
 * confused, and no migration was needed to tell them apart.
 *
 * Plain data and string handling only, safe on either side.
 */

export type MeetingMode = "office" | "online";

export const ATTENDEE_STATUS = ["NEEDS_ACTION", "ACCEPTED", "TENTATIVE", "DECLINED"] as const;
export type AttendeeStatus = (typeof ATTENDEE_STATUS)[number];

export const RSVP_LABELS: Record<AttendeeStatus, string> = {
  NEEDS_ACTION: "Not answered",
  ACCEPTED: "Going",
  TENTATIVE: "Maybe",
  DECLINED: "Can't go",
};

/** What an online meeting with no link yet stores as its place. */
export const ONLINE_PLACE = "Online";

/** Lengths offered as one-tap choices. Anything else is typed as an end time. */
export const DURATIONS = [15, 30, 45, 60, 90, 120] as const;

export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h} ${h === 1 ? "hour" : "hours"}`;
}

/**
 * Online when there is a link, or when the place says so. Everything else is
 * in the office: that is where a meeting with no link happens.
 */
export function meetingMode(location: string | null | undefined, meetingUrl: string | null | undefined): MeetingMode {
  if (meetingUrl && meetingUrl.trim()) return "online";
  if ((location ?? "").trim().toLowerCase().startsWith("online")) return "online";
  return "office";
}

/**
 * A pasted link, made into one a browser will open: "meet.google.com/abc"
 * gains its https://. Returns null for anything that is not a web address,
 * so a typo cannot become a link that goes nowhere.
 */
export function normaliseMeetingUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** "Google Meet", "Zoom", "Teams", or the bare host for anything else. */
export function meetingProvider(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host.endsWith("meet.google.com")) return "Google Meet";
    if (host.endsWith("zoom.us")) return "Zoom";
    if (host.endsWith("teams.microsoft.com") || host.endsWith("teams.live.com")) return "Teams";
    if (host.endsWith("whereby.com")) return "Whereby";
    if (host.endsWith("webex.com")) return "Webex";
    return host;
  } catch {
    return null;
  }
}

/** "In office · Board room", "Online · Google Meet", "Online · link to follow". */
export function placeLabel(mode: MeetingMode, location: string | null | undefined, meetingUrl: string | null | undefined): string {
  if (mode === "online") {
    const provider = meetingProvider(meetingUrl);
    return provider ? `Online · ${provider}` : "Online · link to follow";
  }
  const room = (location ?? "").trim();
  return room && room.toLowerCase() !== "office" ? `In office · ${room}` : "In office";
}
