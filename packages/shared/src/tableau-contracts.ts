import { z } from 'zod';

export const TableauGroupCreationAccessSchema = z.object({
  state: z.enum(['allowed', 'denied', 'unknown']),
  reasonCode: z.string().min(1).max(80),
  message: z.string().min(1).max(600),
  checkedAt: z.number().int().nonnegative().optional(),
});
export type TableauGroupCreationAccess = z.infer<typeof TableauGroupCreationAccessSchema>;
