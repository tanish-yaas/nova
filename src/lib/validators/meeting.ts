import { z } from "zod";

/**
 * Field-level checks only. Times arrive as the "YYYY-MM-DDTHH:mm" the date
 * fields speak and are ordered in the action, after fromLocalInput has read
 * them as IST.
 */
export const meetingInputSchema = z.object({
  title: z.string().trim().min(1, "Give the meeting a name").max(200),
  agenda: z.string().trim().max(5000).optional().default(""),
  startAt: z.string().min(1, "Pick when it starts"),
  endAt: z.string().min(1, "Pick when it ends"),
  mode: z.enum(["office", "online"]),
  /** In the office: which room or spot. Optional. */
  place: z.string().trim().max(200).optional().default(""),
  /** Online: the call link. Optional, so a link can follow later. */
  link: z.string().trim().max(500).optional().default(""),
  /** Everyone invited besides the organizer. */
  attendeeIds: z.array(z.string().min(1)).max(100).default([]),
});

export type MeetingInput = z.input<typeof meetingInputSchema>;

export const rsvpSchema = z.enum(["ACCEPTED", "TENTATIVE", "DECLINED"]);
