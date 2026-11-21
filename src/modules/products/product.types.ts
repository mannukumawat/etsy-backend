import type { z } from 'zod';
import type { productInputSchema } from './product.schema.js';

export type ProductInput = z.infer<typeof productInputSchema>;
export type ProductStatus = ProductInput['status'];

/** Raw (trimmed) query-string filters of the owner product list (H16: server-side). */
export interface ProductListQuery {
  q: string;
  status: string;
  category: string;
  /** 'in' | 'low' | 'out' — worst-variant stock state, using the live low-stock threshold. */
  stock: string;
  /** 'featured' | 'bestseller' | 'new'. */
  flag: string;
  /** 'name' | 'price' | 'stock' | 'updated' | 'order'. */
  sort: string;
  dir: 'asc' | 'desc';
  /** Item-group id (the admin deep-links with the id, not the slug). */
  itemGroup: string;
  /** 1-based page; the route clamps it to >= 1. */
  page: number;
  /** Page size; the route clamps it to 1..MAX_PAGE_SIZE. */
  pageSize: number;
}

/** Parsed filters of the public catalog list. */
export interface StorefrontProductQuery {
  q: string;
  categories: string[];
  ids: string[];
  /** 1-based page; the route clamps it to >= 1. */
  page: number;
  /** Page size; the route clamps it to 1..200. */
  limit: number;
}
