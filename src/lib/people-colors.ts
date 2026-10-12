/**
 * The colour each person is drawn in when several calendars are on screen.
 *
 * The dark steps of the reference categorical palette, in its validated
 * order, checked against Nova's panel surface (#1c1c1f): every slot clears
 * the lightness band, chroma floor, 3:1 contrast and adjacent CVD and
 * normal-vision separation. Colour is never the only thing naming a person:
 * the people picker labels each colour, and every chip says whose it is.
 *
 * A person's colour comes from their place in the workspace roster, not from
 * who else happens to be selected, so picking a second person never repaints
 * the first. Past eight people the palette stops rather than repeating:
 * the ninth onward share a neutral grey and lean on their names.
 */
export const PERSON_COLORS = [
  "#3987e5",
  "#d95926",
  "#199e70",
  "#c98500",
  "#d55181",
  "#008300",
  "#9085e9",
  "#e66767",
] as const;

export const OTHER_PERSON_COLOR = "#8b8b94";

export function personColor(rosterIndex: number): string {
  return rosterIndex >= 0 && rosterIndex < PERSON_COLORS.length
    ? PERSON_COLORS[rosterIndex]
    : OTHER_PERSON_COLOR;
}
