import type { z } from 'zod';
import type { productInputSchema } from './product.schema.js';

export type ProductInput = z.infer<typeof productInputSchema>;
export type ProductStatus = ProductInput['status'];

/** Raw (trimmed) query-string filters of the owner product list. */
export interface ProductListQuery {
  q: string;
  status: string;
  itemGroup: string;
}

/** Parsed filters of the public catalog list. */
export interface StorefrontProductQuery {
  q: string;
  categories: string[];
  ids: string[];
  limit: number;
}
