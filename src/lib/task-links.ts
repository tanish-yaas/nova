/**
 * Deliverable links on a task: how a pasted address is cleaned up, and how it
 * reads when there is no room for all of it.
 *
 * Shared by the task sheet, the action that saves them and the report exports,
 * so a link that was accepted on the sheet is the same link the PDF points at.
 */

export const MAX_LINKS_PER_TASK = 50;
/** Excel will not keep a hyperlink longer than 2,079 characters. */
export const MAX_LINK_LENGTH = 2000;
export const MAX_LINK_LABEL = 120;

export type TaskLinkItem = { id: string; url: string; label: string | null };

/**
 * A pasted address as an absolute http(s) URL, or null when it is not one.
 *
 * "drive.google.com/…" is how people copy from the address bar, so a missing
 * scheme is read as https. Anything else (javascript:, mailto:, a file path)
 * is refused: these become clickable in the app and in every export.
 */
export function normalizeLink(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > MAX_LINK_LENGTH || /\s/.test(value)) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // "https://notes" parses, but nobody's deliverable lives at a bare word.
  if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;

  return url.toString();
}

/** "drive.google.com/drive/folders/1Ab…", for a cell too narrow for the URL. */
export function shortLink(url: string, max = 48): string {
  let text = url;
  try {
    const parsed = new URL(url);
    text = `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    // Stored links were normalized on the way in; fall back to the raw text.
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The name when someone gave one, the shortened address otherwise. */
export function linkText(link: { url: string; label: string | null }, max?: number): string {
  return link.label?.trim() || shortLink(link.url, max);
}
