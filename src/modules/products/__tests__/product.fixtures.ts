import type { ProductRow } from '../product.mapper.js';

export const FIXTURE_TIME = new Date('2026-03-01T10:00:00.000Z');

const category = {
  id: 'ceramics',
  slug: 'ceramics',
  nameEn: 'Ceramics',
  nameHi: '',
  descriptionEn: '',
  descriptionHi: '',
  imageId: null,
  bannerId: null,
  displayOrder: 0,
  isActive: true,
  createdAt: FIXTURE_TIME,
  updatedAt: FIXTURE_TIME,
};

/** A complete, publishable product (two colour variants, one image, one spec) as Prisma returns it. */
export function productRow(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: 'p-test-mug',
    slug: 'test-mug',
    status: 'draft',
    nameEn: 'Test Mug',
    nameHi: '',
    nameSearch: 'test mug',
    shortDescriptionEn: 'A sturdy mug',
    shortDescriptionHi: '',
    descriptionEn: 'A very nice, sturdy mug.',
    descriptionHi: '',
    categoryId: 'ceramics',
    itemGroupId: null,
    navLinkId: null,
    tags: JSON.stringify(['mug']),
    searchText: 'test mug test-mug mug test-mug-red test-mug-blue',
    basePrice: 1500,
    baseSalePrice: null,
    materialsEn: '',
    materialsHi: '',
    careEn: '',
    careHi: '',
    returnsAllowed: true,
    exchangeAllowed: true,
    returnDays: 30,
    weightValue: null,
    weightUnit: 'g',
    dimLength: null,
    dimWidth: null,
    dimHeight: null,
    dimUnit: 'cm',
    isFeatured: false,
    isBestseller: false,
    isNew: false,
    displayOrder: 100,
    seoTitleEn: '',
    seoTitleHi: '',
    seoDescriptionEn: '',
    seoDescriptionHi: '',
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    images: [{ id: 'img_1', productId: 'p-test-mug', mediaId: 'm_1', position: 0, altEn: 'A mug', altHi: '' }],
    options: [
      {
        id: 'p-test-mug__color',
        productId: 'p-test-mug',
        nameEn: 'Color',
        nameHi: '',
        type: 'swatch',
        position: 0,
        values: [
          { id: 'p-test-mug__color__red', optionId: 'p-test-mug__color', labelEn: 'Red', labelHi: '', swatch: '#C04A17', position: 0 },
          { id: 'p-test-mug__color__blue', optionId: 'p-test-mug__color', labelEn: 'Blue', labelHi: '', swatch: '#1F4E79', position: 1 },
        ],
      },
    ],
    variants: [
      {
        id: 'p-test-mug--v-red',
        productId: 'p-test-mug',
        sku: 'TEST-MUG-RED',
        options: JSON.stringify({ 'p-test-mug__color': 'p-test-mug__color__red' }),
        price: 1500,
        salePrice: null,
        stock: 5,
        imageIds: JSON.stringify(['m_1']),
        position: 0,
      },
      {
        id: 'p-test-mug--v-blue',
        productId: 'p-test-mug',
        sku: 'TEST-MUG-BLUE',
        options: JSON.stringify({ 'p-test-mug__color': 'p-test-mug__color__blue' }),
        price: 1500,
        salePrice: null,
        stock: 0,
        imageIds: JSON.stringify([]),
        position: 1,
      },
    ],
    specs: [{ id: 'p-test-mug__spec__s1', productId: 'p-test-mug', labelEn: 'Capacity', labelHi: '', valueEn: '350 ml', valueHi: '', position: 0 }],
    category,
    ...overrides,
  };
}

/** Smallest valid body for POST /api/admin/products (a draft with one variant and no options). */
export function validProductBody(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'test-mug',
    name: { en: 'Test Mug', hi: '' },
    shortDescription: { en: '' },
    description: { en: '' },
    materials: { en: '' },
    care: { en: '' },
    categoryId: 'ceramics',
    basePrice: 1500,
    variants: [{ id: 'v1', sku: 'TEST-MUG-1', price: 1500, stock: 5 }],
    ...overrides,
  };
}
