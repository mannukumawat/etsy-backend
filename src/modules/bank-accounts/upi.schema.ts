import { z } from 'zod';

export const addUpiSchema = z.object({
  upiId: z.string().trim().min(3, 'Enter a valid UPI ID.').max(100).regex(/^[\w.\-]+@[\w.\-]+$/, 'Invalid UPI ID format.'),
  holderName: z.string().trim().min(2, 'Enter holder name.').max(80),
});
export type AddUpiInput = z.infer<typeof addUpiSchema>;
