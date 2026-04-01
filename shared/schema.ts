import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, decimal, boolean, timestamp, pgEnum, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const roleEnum = pgEnum("role", ["client", "admin", "superadmin"]);
export const orderStatusEnum = pgEnum("order_status", ["pending", "processing", "completed", "cancelled"]);
export const targetStatusEnum = pgEnum("target_status", ["active", "completed", "missed"]);
export const withdrawalStatusEnum = pgEnum("withdrawal_status", ["pending", "approved", "rejected"]);
export const noticeTypeEnum = pgEnum("notice_type", ["system", "promotion", "warning", "info"]);
export const bulkOrderStatusEnum = pgEnum("bulk_order_status", ["pending", "accepted", "declined", "expired", "completed"]);

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  age: integer("age").notNull(),
  profession: text("profession").notNull(),
  phone: text("phone").default(""),
  role: roleEnum("role").notNull().default("client"),
  isFrozen: boolean("is_frozen").notNull().default(false),
  balance: decimal("balance", { precision: 12, scale: 2 }).notNull().default("0"),
  grade: decimal("grade", { precision: 3, scale: 1 }).notNull().default("5.0"),
  credit: integer("credit").notNull().default(100),
  goodRate: decimal("good_rate", { precision: 5, scale: 2 }).notNull().default("100.00"),
  vipLevel: integer("vip_level").notNull().default(1),
  rating: decimal("rating", { precision: 3, scale: 1 }).notNull().default("5.0"),
  referenceCode: text("reference_code").unique(),
  referredBy: varchar("referred_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const stores = pgTable("stores", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ownerId: varchar("owner_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  logoUrl: text("logo_url"),
  nicImageUrl: text("nic_image_url"),
  referenceCode: text("reference_code"),
  isActive: boolean("is_active").notNull().default(true),
  isApproved: boolean("is_approved").notNull().default(true),
  visitors: integer("visitors").notNull().default(0),
  adminNotes: text("admin_notes").default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const passwordResetRequests = pgTable("password_reset_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  nicImageUrl: text("nic_image_url").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const products = pgTable("products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  storeId: varchar("store_id").notNull().references(() => stores.id),
  name: text("name").notNull(),
  details: text("details"),
  description: text("description").notNull(),
  detailedDescription: text("detailed_description"),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  costPrice: decimal("cost_price", { precision: 10, scale: 2 }).notNull().default("0"),
  category: text("category").notNull(),
  imageUrl: text("image_url"),
  images: text("images").array(),
  imageWidth: integer("image_width"),
  imageHeight: integer("image_height"),
  stock: integer("stock").notNull().default(0),
  salesCount: integer("sales_count").notNull().default(0),
  clickCount: integer("click_count").notNull().default(0),
  isAdminProduct: boolean("is_admin_product").notNull().default(false),
  adminProductId: varchar("admin_product_id"),
  rating: decimal("rating", { precision: 2, scale: 1 }).notNull().default("5.0"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const orders = pgTable("orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orderSn: text("order_sn").notNull().default(sql`concat('ORD', to_char(now(), 'YYYYMMDD'), floor(random()*1000000)::text)`),
  batchId: varchar("batch_id"),
  buyerId: varchar("buyer_id").notNull().references(() => users.id),
  productId: varchar("product_id").notNull().references(() => products.id),
  storeId: varchar("store_id").notNull().references(() => stores.id),
  quantity: integer("quantity").notNull().default(1),
  totalPrice: decimal("total_price", { precision: 10, scale: 2 }).notNull(),
  payPrice: decimal("pay_price", { precision: 10, scale: 2 }).notNull().default("0"),
  profit: decimal("profit", { precision: 10, scale: 2 }).notNull().default("0"),
  status: orderStatusEnum("status").notNull().default("pending"),
  remark: text("remark").default(""),
  deliveryAddress: text("delivery_address"),
  orderedBy: varchar("ordered_by").references(() => users.id),
  deliverToUserId: varchar("deliver_to_user_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const targets = pgTable("targets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  assignedBy: varchar("assigned_by").notNull().references(() => users.id),
  title: text("title").notNull(),
  description: text("description").notNull(),
  targetAmount: decimal("target_amount", { precision: 10, scale: 2 }).notNull(),
  currentAmount: decimal("current_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  deadline: timestamp("deadline").notNull(),
  status: targetStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  senderId: varchar("sender_id").notNull().references(() => users.id),
  receiverId: varchar("receiver_id").references(() => users.id),
  content: text("content").notNull(),
  imageUrl: text("image_url"),
  isRead: boolean("is_read").notNull().default(false),
  isPinned: boolean("is_pinned").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const withdrawals = pgTable("withdrawals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  storeId: varchar("store_id").references(() => stores.id),
  extractSn: text("extract_sn").notNull().default(sql`concat('TX', to_char(now(), 'YYYYMMDDHH24MISS'), floor(random()*1000000)::text)`),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  paymentMethod: text("payment_method").notNull().default("bank"),
  bankDetails: text("bank_details"),
  trc20Address: text("trc20_address"),
  status: withdrawalStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const merchantNotices = pgTable("merchant_notices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  storeId: varchar("store_id").references(() => stores.id),
  userId: varchar("user_id").references(() => users.id),
  type: noticeTypeEnum("type").notNull().default("system"),
  title: text("title").notNull(),
  content: text("content").notNull().default(""),
  isSeen: boolean("is_seen").notNull().default(false),
  seenAt: timestamp("seen_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const rechargeHistory = pgTable("recharge_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  previousBalance: decimal("previous_balance", { precision: 12, scale: 2 }).notNull(),
  newBalance: decimal("new_balance", { precision: 12, scale: 2 }).notNull(),
  rechargedBy: varchar("recharged_by").notNull().references(() => users.id),
  note: text("note").default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const userDailyStats = pgTable("user_daily_stats", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  date: text("date").notNull(),
  purchases: decimal("purchases", { precision: 12, scale: 2 }).notNull().default("0"),
  sales: decimal("sales", { precision: 12, scale: 2 }).notNull().default("0"),
  profit: decimal("profit", { precision: 12, scale: 2 }).notNull().default("0"),
  setBy: varchar("set_by").references(() => users.id),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const productImages = pgTable("product_images", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  productId: varchar("product_id").notNull(),
  data: text("data").notNull(),
  mimeType: varchar("mime_type", { length: 50 }).notNull().default("image/jpeg"),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const backups = pgTable("backups", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  label: varchar("label", { length: 20 }).notNull(), // 'current' or 'previous'
  data: text("data").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const bulkOrders = pgTable("bulk_orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  batchSn: text("batch_sn").notNull().default(sql`concat('BULK', to_char(now(), 'YYYYMMDD'), floor(random()*100000)::text)`),
  adminId: varchar("admin_id").notNull().references(() => users.id),
  storeId: varchar("store_id").notNull().references(() => stores.id),
  shippingAddress: text("shipping_address").default(""),
  status: bulkOrderStatusEnum("status").notNull().default("pending"),
  note: text("note").default(""),
  totalCost: decimal("total_cost", { precision: 10, scale: 2 }).notNull().default("0"),
  totalProfit: decimal("total_profit", { precision: 10, scale: 2 }).notNull().default("0"),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const bulkOrderItems = pgTable("bulk_order_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  bulkOrderId: varchar("bulk_order_id").notNull().references(() => bulkOrders.id),
  productId: varchar("product_id").notNull(),
  productName: text("product_name").notNull(),
  quantity: integer("quantity").notNull().default(1),
  costPrice: decimal("cost_price", { precision: 10, scale: 2 }).notNull(),
  profitAmount: decimal("profit_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  sellingPrice: decimal("selling_price", { precision: 10, scale: 2 }).notNull(),
});

export type Backup = typeof backups.$inferSelect;

export const siteSettings = pgTable("site_settings", {
  id: integer("id").primaryKey().default(1),
  siteName: text("site_name").notNull().default("MarketNest"),
  contactEmail: text("contact_email").notNull().default(""),
  contactPhone: text("contact_phone").notNull().default("+1 (800) 123-4567"),
  contactAddress: text("contact_address").notNull().default("123 Commerce Street, Business District, NY 10001, USA"),
  contactWhatsapp: text("contact_whatsapp").notNull().default("+1 (800) 123-4567"),
  contactTelegram: text("contact_telegram").notNull().default("@marketnest_support"),
  contactHours: text("contact_hours").notNull().default("Monday–Friday, 9:00 AM – 6:00 PM (EST)"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type SiteSettings = typeof siteSettings.$inferSelect;
export type InsertSiteSettings = typeof siteSettings.$inferInsert;

export const insertProductImageSchema = createInsertSchema(productImages).omit({ id: true, createdAt: true });

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, role: true, isFrozen: true, balance: true, grade: true, credit: true, goodRate: true, vipLevel: true, rating: true, referenceCode: true, referredBy: true });
export const insertStoreSchema = createInsertSchema(stores).omit({ id: true, createdAt: true, isActive: true, isApproved: true, visitors: true, adminNotes: true });
export const insertPasswordResetRequestSchema = createInsertSchema(passwordResetRequests).omit({ id: true, createdAt: true, status: true });
export const insertProductSchema = createInsertSchema(products).omit({ id: true, createdAt: true, salesCount: true, clickCount: true });
export const insertOrderSchema = createInsertSchema(orders).omit({ id: true, createdAt: true, status: true, orderSn: true });
export const insertTargetSchema = createInsertSchema(targets).omit({ id: true, createdAt: true, status: true, currentAmount: true });
export const insertChatMessageSchema = createInsertSchema(chatMessages).omit({ id: true, createdAt: true, isRead: true });
export const insertWithdrawalSchema = createInsertSchema(withdrawals).omit({ id: true, createdAt: true, status: true, extractSn: true });
export const insertNoticeSchema = createInsertSchema(merchantNotices).omit({ id: true, createdAt: true, isSeen: true, seenAt: true });
export const insertRechargeHistorySchema = createInsertSchema(rechargeHistory).omit({ id: true, createdAt: true });
export const insertUserDailyStatsSchema = createInsertSchema(userDailyStats).omit({ id: true, updatedAt: true });
export const insertBulkOrderSchema = createInsertSchema(bulkOrders).omit({ id: true, createdAt: true, batchSn: true, acceptedAt: true });
export const insertBulkOrderItemSchema = createInsertSchema(bulkOrderItems).omit({ id: true });

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertStore = z.infer<typeof insertStoreSchema>;
export type Store = typeof stores.$inferSelect;
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof products.$inferSelect;
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof orders.$inferSelect;
export type InsertTarget = z.infer<typeof insertTargetSchema>;
export type Target = typeof targets.$inferSelect;
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertWithdrawal = z.infer<typeof insertWithdrawalSchema>;
export type Withdrawal = typeof withdrawals.$inferSelect;
export type InsertNotice = z.infer<typeof insertNoticeSchema>;
export type MerchantNotice = typeof merchantNotices.$inferSelect;
export type InsertPasswordResetRequest = z.infer<typeof insertPasswordResetRequestSchema>;
export type PasswordResetRequest = typeof passwordResetRequests.$inferSelect;
export type InsertProductImage = z.infer<typeof insertProductImageSchema>;
export type ProductImage = typeof productImages.$inferSelect;
export type InsertRechargeHistory = z.infer<typeof insertRechargeHistorySchema>;
export type RechargeHistory = typeof rechargeHistory.$inferSelect;
export type InsertUserDailyStat = z.infer<typeof insertUserDailyStatsSchema>;
export type UserDailyStat = typeof userDailyStats.$inferSelect;
export type InsertBulkOrder = z.infer<typeof insertBulkOrderSchema>;
export type BulkOrder = typeof bulkOrders.$inferSelect;
export type InsertBulkOrderItem = z.infer<typeof insertBulkOrderItemSchema>;
export type BulkOrderItem = typeof bulkOrderItems.$inferSelect;
