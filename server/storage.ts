import { drizzle } from "drizzle-orm/node-postgres";
import { eq, desc, and, or, sql } from "drizzle-orm";
import pkg from "pg";
const { Pool } = pkg;
import {
  users, stores, products, orders, targets, chatMessages, withdrawals, merchantNotices, passwordResetRequests, rechargeHistory, userDailyStats, siteSettings, bulkOrders, bulkOrderItems,
  type User, type InsertUser,
  type Store, type InsertStore,
  type Product, type InsertProduct,
  type Order, type InsertOrder,
  type Target, type InsertTarget,
  type ChatMessage, type InsertChatMessage,
  type Withdrawal, type InsertWithdrawal,
  type MerchantNotice, type InsertNotice,
  type PasswordResetRequest, type InsertPasswordResetRequest,
  type RechargeHistory, type InsertRechargeHistory,
  type UserDailyStat, type InsertUserDailyStat,
  type SiteSettings,
  type BulkOrder, type InsertBulkOrder,
  type BulkOrderItem, type InsertBulkOrderItem,
} from "@shared/schema";

// Use individual Supabase params when available (avoids URL special-char encoding issues).
// Falls back to connection string (DATABASE_URL) for Replit built-in DB.
//
// IMPORTANT: When connecting to Supabase via the pooler domain (*.pooler.supabase.com),
// use port 6543 (Transaction mode) for the main query pool — it supports far more
// concurrent clients than port 5432 (Session mode), which has a hard cap equal to
// PgBouncer's pool_size and causes "MaxClientsInSessionMode" errors under load.
// The LISTEN client in routes.ts uses port 5432 (Session mode) because LISTEN is not
// supported in Transaction mode.
const isSupabasePooler = (process.env.SUPA_HOST || "").includes("pooler.supabase.com");

const supabasePoolConfig = process.env.SUPA_HOST
  ? {
      host: process.env.SUPA_HOST,
      user: process.env.SUPA_USER,
      password: process.env.SUPA_PASS,
      database: process.env.SUPA_DB || "postgres",
      // Use Transaction mode port (6543) on the pooler — session mode port (5432)
      // exhausts quickly when multiple instances or concurrent startups occur.
      port: isSupabasePooler ? 6543 : parseInt(process.env.SUPA_PORT || "5432"),
      ssl: { rejectUnauthorized: false },
    }
  : {
      connectionString: process.env.DATABASE_URL,
      ssl: false as const,
    };

const pool = new Pool({
  ...supabasePoolConfig,
  max: 3,                        // keep well under Supabase limits even with multiple restarts
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 8000,
});

process.on("SIGTERM", () => pool.end());
process.on("SIGINT", () => pool.end());

pool.on("error", (err) => {
  console.error("Database pool error:", err.message);
});

export const db = drizzle(pool);
export { pool };

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getAllUsers(): Promise<User[]>;
  updateUserFrozen(id: string, isFrozen: boolean): Promise<User | undefined>;
  updateUser(id: string, data: Partial<User>): Promise<User | undefined>;
  getAdminUser(): Promise<User | undefined>;

  getStore(id: string): Promise<Store | undefined>;
  getStoresByOwner(ownerId: string): Promise<Store[]>;
  getAllStores(): Promise<Store[]>;
  createStore(store: InsertStore): Promise<Store>;
  updateStore(id: string, data: Partial<InsertStore>): Promise<Store | undefined>;
  deleteStore(id: string): Promise<void>;
  updateStoreVisitors(id: string, visitors: number): Promise<Store | undefined>;

  getProduct(id: string): Promise<Product | undefined>;
  getProductsByStore(storeId: string): Promise<Product[]>;
  getAllProducts(): Promise<Product[]>;
  getAdminProducts(): Promise<Product[]>;
  createProduct(product: InsertProduct): Promise<Product>;
  updateProduct(id: string, data: Partial<InsertProduct>): Promise<Product | undefined>;
  deleteProduct(id: string): Promise<void>;
  deleteProductWithChildren(id: string): Promise<void>;
  getOrdersByProduct(productId: string): Promise<Order[]>;

  getOrder(id: string): Promise<Order | undefined>;
  getOrdersByBuyer(buyerId: string): Promise<Order[]>;
  getOrdersByStore(storeId: string): Promise<Order[]>;
  getAllOrders(): Promise<Order[]>;
  createOrder(order: InsertOrder): Promise<Order>;
  updateOrderStatus(id: string, status: string): Promise<Order | undefined>;

  getTarget(id: string): Promise<Target | undefined>;
  getTargetsByUser(userId: string): Promise<Target[]>;
  getAllTargets(): Promise<Target[]>;
  createTarget(target: InsertTarget): Promise<Target>;
  updateTarget(id: string, data: Partial<Target>): Promise<Target | undefined>;

  getChatMessages(userId: string): Promise<ChatMessage[]>;
  getAllChatMessages(): Promise<ChatMessage[]>;
  createChatMessage(message: InsertChatMessage): Promise<ChatMessage>;
  markMessagesRead(receiverId: string, senderId: string, isAdmin?: boolean): Promise<void>;
  getUnreadCount(userId: string): Promise<number>;
  pinChatMessage(id: string): Promise<ChatMessage | undefined>;
  unpinAllChatMessages(): Promise<void>;
  getPinnedChatMessage(): Promise<ChatMessage | undefined>;

  getWithdrawal(id: string): Promise<Withdrawal | undefined>;
  getWithdrawalsByUser(userId: string): Promise<Withdrawal[]>;
  getAllWithdrawals(): Promise<Withdrawal[]>;
  createWithdrawal(w: InsertWithdrawal): Promise<Withdrawal>;
  updateWithdrawalStatus(id: string, status: string): Promise<Withdrawal | undefined>;

  getNotice(id: string): Promise<MerchantNotice | undefined>;
  getNoticesByUser(userId: string): Promise<MerchantNotice[]>;
  getNoticesByStore(storeId: string): Promise<MerchantNotice[]>;
  getAllNotices(): Promise<MerchantNotice[]>;
  createNotice(n: InsertNotice): Promise<MerchantNotice>;
  markNoticeSeen(id: string): Promise<MerchantNotice | undefined>;

  getAllPasswordResetRequests(): Promise<PasswordResetRequest[]>;
  createPasswordResetRequest(r: InsertPasswordResetRequest): Promise<PasswordResetRequest>;
  updatePasswordResetRequestStatus(id: string, status: string): Promise<PasswordResetRequest | undefined>;

  createRechargeRecord(r: InsertRechargeHistory): Promise<RechargeHistory>;
  getAllRechargeHistory(): Promise<RechargeHistory[]>;
  getRechargeHistoryByUser(userId: string): Promise<RechargeHistory[]>;

  getSiteSettings(): Promise<SiteSettings>;
  updateSiteSettings(data: Partial<SiteSettings>): Promise<SiteSettings>;

  createBulkOrder(data: InsertBulkOrder): Promise<BulkOrder>;
  getBulkOrder(id: string): Promise<BulkOrder | undefined>;
  getAllBulkOrders(): Promise<BulkOrder[]>;
  getBulkOrdersByStore(storeId: string): Promise<BulkOrder[]>;
  updateBulkOrder(id: string, data: Partial<BulkOrder>): Promise<BulkOrder | undefined>;
  createBulkOrderItem(data: InsertBulkOrderItem): Promise<BulkOrderItem>;
  getBulkOrderItems(bulkOrderId: string): Promise<BulkOrderItem[]>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user;
  }

  async createUser(user: InsertUser): Promise<User> {
    const [created] = await db.insert(users).values(user).returning();
    return created;
  }

  async getAllUsers(): Promise<User[]> {
    return db.select().from(users).orderBy(desc(users.createdAt));
  }

  async updateUserFrozen(id: string, isFrozen: boolean): Promise<User | undefined> {
    const [updated] = await db.update(users).set({ isFrozen }).where(eq(users.id, id)).returning();
    return updated;
  }

  async updateUser(id: string, data: Partial<User>): Promise<User | undefined> {
    const [updated] = await db.update(users).set(data as any).where(eq(users.id, id)).returning();
    return updated;
  }

  async getAdminUser(): Promise<User | undefined> {
    const [superAdmin] = await db.select().from(users).where(eq(users.role, "superadmin"));
    if (superAdmin) return superAdmin;
    const [admin] = await db.select().from(users).where(eq(users.role, "admin"));
    return admin;
  }

  async getStore(id: string): Promise<Store | undefined> {
    const [store] = await db.select().from(stores).where(eq(stores.id, id));
    return store;
  }

  async getStoresByOwner(ownerId: string): Promise<Store[]> {
    return db.select().from(stores).where(eq(stores.ownerId, ownerId)).orderBy(desc(stores.createdAt));
  }

  async getAllStores(): Promise<Store[]> {
    return db.select().from(stores).orderBy(desc(stores.createdAt));
  }

  async createStore(store: InsertStore): Promise<Store> {
    const [created] = await db.insert(stores).values(store).returning();
    return created;
  }

  async updateStore(id: string, data: Partial<InsertStore>): Promise<Store | undefined> {
    const [updated] = await db.update(stores).set(data).where(eq(stores.id, id)).returning();
    return updated;
  }

  async deleteStore(id: string): Promise<void> {
    await db.delete(stores).where(eq(stores.id, id));
  }

  async updateStoreVisitors(id: string, visitors: number): Promise<Store | undefined> {
    const [updated] = await db.update(stores).set({ visitors }).where(eq(stores.id, id)).returning();
    return updated;
  }

  async getProduct(id: string): Promise<Product | undefined> {
    const [product] = await db.select().from(products).where(eq(products.id, id));
    return product;
  }

  async getProductsByStore(storeId: string): Promise<Product[]> {
    return db.select().from(products).where(eq(products.storeId, storeId)).orderBy(desc(products.createdAt));
  }

  async getAllProducts(): Promise<Product[]> {
    return db.select().from(products).orderBy(desc(products.createdAt));
  }

  async getAdminProducts(): Promise<Product[]> {
    return db.select().from(products).where(eq(products.isAdminProduct, true)).orderBy(desc(products.createdAt));
  }

  async createProduct(product: InsertProduct): Promise<Product> {
    const [created] = await db.insert(products).values(product).returning();
    return created;
  }

  async updateProduct(id: string, data: Partial<InsertProduct>): Promise<Product | undefined> {
    const [updated] = await db.update(products).set(data).where(eq(products.id, id)).returning();
    return updated;
  }

  async deleteProduct(id: string): Promise<void> {
    await db.delete(products).where(eq(products.id, id));
  }

  async getOrdersByProduct(productId: string): Promise<Order[]> {
    return db.select().from(orders).where(eq(orders.productId, productId));
  }

  async deleteProductWithChildren(id: string): Promise<void> {
    const childProducts = await db.select().from(products).where(eq(products.adminProductId, id));
    for (const child of childProducts) {
      await db.delete(orders).where(eq(orders.productId, child.id));
      await db.delete(products).where(eq(products.id, child.id));
    }
    await db.delete(products).where(eq(products.id, id));
  }

  async getOrder(id: string): Promise<Order | undefined> {
    const [order] = await db.select().from(orders).where(eq(orders.id, id));
    return order;
  }

  async getOrdersByBuyer(buyerId: string): Promise<Order[]> {
    return db.select().from(orders).where(eq(orders.buyerId, buyerId)).orderBy(desc(orders.createdAt));
  }

  async getOrdersByStore(storeId: string): Promise<Order[]> {
    return db.select().from(orders).where(eq(orders.storeId, storeId)).orderBy(desc(orders.createdAt));
  }

  async getAllOrders(): Promise<Order[]> {
    return db.select().from(orders).orderBy(desc(orders.createdAt));
  }

  async createOrder(order: InsertOrder): Promise<Order> {
    const [created] = await db.insert(orders).values(order).returning();
    return created;
  }

  async updateOrderStatus(id: string, status: string): Promise<Order | undefined> {
    const [updated] = await db.update(orders).set({ status: status as any }).where(eq(orders.id, id)).returning();
    return updated;
  }

  async getTarget(id: string): Promise<Target | undefined> {
    const [target] = await db.select().from(targets).where(eq(targets.id, id));
    return target;
  }

  async getTargetsByUser(userId: string): Promise<Target[]> {
    return db.select().from(targets).where(eq(targets.userId, userId)).orderBy(desc(targets.createdAt));
  }

  async getAllTargets(): Promise<Target[]> {
    return db.select().from(targets).orderBy(desc(targets.createdAt));
  }

  async createTarget(target: InsertTarget): Promise<Target> {
    const [created] = await db.insert(targets).values(target).returning();
    return created;
  }

  async updateTarget(id: string, data: Partial<Target>): Promise<Target | undefined> {
    const [updated] = await db.update(targets).set(data as any).where(eq(targets.id, id)).returning();
    return updated;
  }

  async getChatMessages(userId: string): Promise<ChatMessage[]> {
    return db.select().from(chatMessages)
      .where(or(eq(chatMessages.senderId, userId), eq(chatMessages.receiverId, userId)))
      .orderBy(chatMessages.createdAt);
  }

  async getAllChatMessages(): Promise<ChatMessage[]> {
    return db.select().from(chatMessages).orderBy(chatMessages.createdAt);
  }

  async createChatMessage(message: InsertChatMessage): Promise<ChatMessage> {
    const [created] = await db.insert(chatMessages).values(message).returning();
    return created;
  }

  async markMessagesRead(receiverId: string, senderId: string, isAdmin?: boolean): Promise<void> {
    if (isAdmin) {
      await db.update(chatMessages)
        .set({ isRead: true })
        .where(and(
          sql`(${chatMessages.receiverId} IS NULL OR ${chatMessages.receiverId} = ${receiverId})`,
          eq(chatMessages.senderId, senderId)
        ));
    } else {
      await db.update(chatMessages)
        .set({ isRead: true })
        .where(and(eq(chatMessages.receiverId, receiverId), eq(chatMessages.senderId, senderId)));
    }
  }

  async getUnreadCount(userId: string): Promise<number> {
    const user = await this.getUser(userId);
    if (user?.role === "admin" || user?.role === "superadmin") {
      const result = await db.select({ count: sql<number>`count(*)` })
        .from(chatMessages)
        .where(and(sql`${chatMessages.receiverId} IS NULL`, eq(chatMessages.isRead, false)));
      return Number(result[0]?.count ?? 0);
    }
    const result = await db.select({ count: sql<number>`count(*)` })
      .from(chatMessages)
      .where(and(eq(chatMessages.receiverId, userId), eq(chatMessages.isRead, false)));
    return Number(result[0]?.count ?? 0);
  }

  async pinChatMessage(id: string): Promise<ChatMessage | undefined> {
    await db.update(chatMessages).set({ isPinned: false });
    const [updated] = await db.update(chatMessages).set({ isPinned: true }).where(eq(chatMessages.id, id)).returning();
    return updated;
  }

  async unpinAllChatMessages(): Promise<void> {
    await db.update(chatMessages).set({ isPinned: false });
  }

  async getPinnedChatMessage(): Promise<ChatMessage | undefined> {
    const [msg] = await db.select().from(chatMessages).where(eq(chatMessages.isPinned, true)).limit(1);
    return msg;
  }

  async getWithdrawal(id: string): Promise<Withdrawal | undefined> {
    const [w] = await db.select().from(withdrawals).where(eq(withdrawals.id, id));
    return w;
  }

  async getWithdrawalsByUser(userId: string): Promise<Withdrawal[]> {
    return db.select().from(withdrawals).where(eq(withdrawals.userId, userId)).orderBy(desc(withdrawals.createdAt));
  }

  async getAllWithdrawals(): Promise<Withdrawal[]> {
    return db.select().from(withdrawals).orderBy(desc(withdrawals.createdAt));
  }

  async createWithdrawal(w: InsertWithdrawal): Promise<Withdrawal> {
    const [created] = await db.insert(withdrawals).values(w).returning();
    return created;
  }

  async updateWithdrawalStatus(id: string, status: string): Promise<Withdrawal | undefined> {
    const [updated] = await db.update(withdrawals).set({ status: status as any }).where(eq(withdrawals.id, id)).returning();
    return updated;
  }

  async getNotice(id: string): Promise<MerchantNotice | undefined> {
    const [n] = await db.select().from(merchantNotices).where(eq(merchantNotices.id, id));
    return n;
  }

  async getNoticesByUser(userId: string): Promise<MerchantNotice[]> {
    return db.select().from(merchantNotices).where(eq(merchantNotices.userId, userId)).orderBy(desc(merchantNotices.createdAt));
  }

  async getNoticesByStore(storeId: string): Promise<MerchantNotice[]> {
    return db.select().from(merchantNotices).where(eq(merchantNotices.storeId, storeId)).orderBy(desc(merchantNotices.createdAt));
  }

  async getAllNotices(): Promise<MerchantNotice[]> {
    return db.select().from(merchantNotices).orderBy(desc(merchantNotices.createdAt));
  }

  async createNotice(n: InsertNotice): Promise<MerchantNotice> {
    const [created] = await db.insert(merchantNotices).values(n).returning();
    return created;
  }

  async markNoticeSeen(id: string): Promise<MerchantNotice | undefined> {
    const [updated] = await db.update(merchantNotices)
      .set({ isSeen: true, seenAt: new Date() })
      .where(eq(merchantNotices.id, id)).returning();
    return updated;
  }

  async getAllPasswordResetRequests(): Promise<PasswordResetRequest[]> {
    return db.select().from(passwordResetRequests).orderBy(desc(passwordResetRequests.createdAt));
  }

  async createPasswordResetRequest(r: InsertPasswordResetRequest): Promise<PasswordResetRequest> {
    const [created] = await db.insert(passwordResetRequests).values(r).returning();
    return created;
  }

  async updatePasswordResetRequestStatus(id: string, status: string): Promise<PasswordResetRequest | undefined> {
    const [updated] = await db.update(passwordResetRequests)
      .set({ status })
      .where(eq(passwordResetRequests.id, id)).returning();
    return updated;
  }

  async createRechargeRecord(r: InsertRechargeHistory): Promise<RechargeHistory> {
    const [created] = await db.insert(rechargeHistory).values(r).returning();
    return created;
  }

  async getAllRechargeHistory(): Promise<RechargeHistory[]> {
    return db.select().from(rechargeHistory).orderBy(desc(rechargeHistory.createdAt));
  }

  async getRechargeHistoryByUser(userId: string): Promise<RechargeHistory[]> {
    return db.select().from(rechargeHistory).where(eq(rechargeHistory.userId, userId)).orderBy(desc(rechargeHistory.createdAt));
  }

  async getDailyStatsByUser(userId: string): Promise<UserDailyStat[]> {
    return db.select().from(userDailyStats).where(eq(userDailyStats.userId, userId)).orderBy(desc(userDailyStats.date));
  }

  async upsertDailyStat(userId: string, date: string, data: { purchases?: string; sales?: string; profit?: string; setBy?: string }): Promise<UserDailyStat> {
    const existing = await db.select().from(userDailyStats).where(and(eq(userDailyStats.userId, userId), eq(userDailyStats.date, date))).limit(1);
    if (existing.length > 0) {
      const [updated] = await db.update(userDailyStats)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(userDailyStats.userId, userId), eq(userDailyStats.date, date)))
        .returning();
      return updated;
    }
    const [created] = await db.insert(userDailyStats).values({ userId, date, ...data }).returning();
    return created;
  }

  async getSiteSettings(): Promise<SiteSettings> {
    const [row] = await db.select().from(siteSettings).where(eq(siteSettings.id, 1));
    if (row) return row;
    const [created] = await db.insert(siteSettings).values({ id: 1 }).returning();
    return created;
  }

  async updateSiteSettings(data: Partial<SiteSettings>): Promise<SiteSettings> {
    const existing = await db.select().from(siteSettings).where(eq(siteSettings.id, 1));
    if (existing.length === 0) {
      const [created] = await db.insert(siteSettings).values({ id: 1, ...data, updatedAt: new Date() }).returning();
      return created;
    }
    const [updated] = await db.update(siteSettings).set({ ...data, updatedAt: new Date() }).where(eq(siteSettings.id, 1)).returning();
    return updated;
  }

  async createBulkOrder(data: InsertBulkOrder): Promise<BulkOrder> {
    const [row] = await db.insert(bulkOrders).values(data as any).returning();
    return row;
  }

  async getBulkOrder(id: string): Promise<BulkOrder | undefined> {
    const [row] = await db.select().from(bulkOrders).where(eq(bulkOrders.id, id));
    return row;
  }

  async getAllBulkOrders(): Promise<BulkOrder[]> {
    return db.select().from(bulkOrders).orderBy(desc(bulkOrders.createdAt));
  }

  async getBulkOrdersByStore(storeId: string): Promise<BulkOrder[]> {
    return db.select().from(bulkOrders).where(eq(bulkOrders.storeId, storeId)).orderBy(desc(bulkOrders.createdAt));
  }

  async updateBulkOrder(id: string, data: Partial<BulkOrder>): Promise<BulkOrder | undefined> {
    const [updated] = await db.update(bulkOrders).set(data as any).where(eq(bulkOrders.id, id)).returning();
    return updated;
  }

  async createBulkOrderItem(data: InsertBulkOrderItem): Promise<BulkOrderItem> {
    const [row] = await db.insert(bulkOrderItems).values(data as any).returning();
    return row;
  }

  async getBulkOrderItems(bulkOrderId: string): Promise<BulkOrderItem[]> {
    return db.select().from(bulkOrderItems).where(eq(bulkOrderItems.bulkOrderId, bulkOrderId));
  }
}

export const storage = new DatabaseStorage();
