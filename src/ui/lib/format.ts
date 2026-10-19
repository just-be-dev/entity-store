import * as DateTime from "effect/DateTime";

/** A stored timestamp (epoch ms) as `YYYY-MM-DD HH:MM:SS UTC`. */
export const formatTime = (epochMillis: number): string =>
  `${DateTime.formatIso(DateTime.makeUnsafe(epochMillis)).slice(0, 19).replace("T", " ")} UTC`;

export const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
