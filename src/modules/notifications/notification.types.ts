/** Shared TypeScript types for the notifications module. */

export interface NotificationRecordDto {
  id: string;
  kind: 'customer' | 'owner';
  recipientId: string;
  event: string;
  title: string;
  body: string;
  link: string;
  isRead: boolean;
  pushStatus: string;
  createdAt: string;
}

export interface NotificationPageDto {
  items: NotificationRecordDto[];
  nextCursor: string | null;
}

export interface UnreadCountDto {
  count: number;
}

export interface SendNotificationInput {
  /** null = broadcast to all customers */
  customerId: string | null;
  title: string;
  body: string;
  link?: string;
}

export interface NotificationSendDto {
  id: string;
  title: string;
  body: string;
  recipientType: 'one' | 'all';
  recipientId: string | null;
  successCount: number;
  failCount: number;
  sentAt: string;
}
