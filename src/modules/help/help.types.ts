// Raw rows of the help_categories / help_articles tables (accessed through raw SQL, not the Prisma client).

export type HelpCategoryRow = {
  id: string; slug: string; nameEn: string; nameHi: string;
  descriptionEn: string | null; descriptionHi: string | null;
  icon: string; position: number; isActive: number;
  createdAt: Date; updatedAt: Date;
};

export type HelpArticleRow = {
  id: string; categoryId: string; slug: string;
  titleEn: string; titleHi: string; bodyEn: string; bodyHi: string | null;
  position: number; isActive: number; createdAt: Date; updatedAt: Date;
};
