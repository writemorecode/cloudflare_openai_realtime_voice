import { expect } from "vitest";
import { z } from "zod";

const aggregateInputSchema = z.unknown();

export function aggregateValue<T>(result: z.input<typeof aggregateInputSchema>): T {
  const parsed = z.object({ status: z.literal("ok"), value: z.custom<T>() }).safeParse(result);
  if (!parsed.success) expect.fail("expected successful aggregate Result");
  return parsed.data.value;
}
