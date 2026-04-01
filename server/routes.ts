import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import cors from "cors";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import crypto from "crypto";
import multer from "multer";
import path from "path";
import fs from "fs";
import AdmZip from "adm-zip";
import archiver from "archiver";
import { storage, db, pool } from "./storage";
import { insertUserSchema, insertStoreSchema, insertProductSchema, insertOrderSchema, insertTargetSchema, insertWithdrawalSchema, insertNoticeSchema } from "@shared/schema";
import { users, products, stores, orders, targets, chatMessages, withdrawals, merchantNotices, rechargeHistory, userDailyStats, productImages, backups, siteSettings, bulkOrders, bulkOrderItems } from "@shared/schema";
import { eq, sql, inArray } from "drizzle-orm";
import pkg from "pg";
const { Client: PgClient } = pkg;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    cb(null, ext && mime);
  },
});

const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = /csv/.test(ext) || ext === ".zip"
      || file.mimetype === "text/csv"
      || file.mimetype === "application/vnd.ms-excel"
      || file.mimetype === "text/plain"
      || file.mimetype === "application/zip"
      || file.mimetype === "application/x-zip-compressed";
    cb(null, ok);
  },
});

async function runDatabaseBackup() {
  try {
    const backupDir = path.join(process.cwd(), "backups");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    // Metadata only — images are backed up separately to Supabase via scheduleImageBackup()
    const [allUsers, allStores, allProducts, allOrders, allTargets, allMessages, allWithdrawals, allNotices, allRecharge, allDailyStats] = await Promise.all([
      db.select().from(users),
      db.select().from(stores),
      db.select().from(products),
      db.select().from(orders),
      db.select().from(targets),
      db.select().from(chatMessages),
      db.select().from(withdrawals),
      db.select().from(merchantNotices),
      db.select().from(rechargeHistory),
      db.select().from(userDailyStats),
    ]);

    const backupData = {
      timestamp: new Date().toISOString(),
      version: 3,
      users: allUsers,
      stores: allStores,
      products: allProducts,
      orders: allOrders,
      targets: allTargets,
      chatMessages: allMessages,
      withdrawals: allWithdrawals,
      merchantNotices: allNotices,
      rechargeHistory: allRecharge,
      userDailyStats: allDailyStats,
    };

    const backupFile = path.join(backupDir, "latest_backup.json");
    const timestampedFile = path.join(backupDir, `backup_${Date.now()}.json`);

    fs.writeFileSync(backupFile, JSON.stringify(backupData));
    fs.writeFileSync(timestampedFile, JSON.stringify(backupData));

    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith("backup_") && f.endsWith(".json"))
      .sort();
    if (files.length > 10) {
      const toDelete = files.slice(0, files.length - 10);
      toDelete.forEach(f => fs.unlinkSync(path.join(backupDir, f)));
    }

    console.log(`[backup] Database backup completed — ${allProducts.length} products (metadata only; images backed up to Supabase)`);
  } catch (err) {
    console.error("[backup] Backup failed:", err);
  }
}

async function restoreFromBackup(backupFile: string): Promise<{ success: boolean; message: string; counts: any }> {
  try {
    if (!fs.existsSync(backupFile)) {
      return { success: false, message: "Backup file not found", counts: {} };
    }

    const raw = fs.readFileSync(backupFile, "utf-8");
    const data = JSON.parse(raw);
    const counts: any = {};

    const upsertRows = async (table: any, rows: any[], tableName: string) => {
      if (!rows || rows.length === 0) { counts[tableName] = 0; return; }
      for (const row of rows) {
        try {
          await db.insert(table).values(row).onConflictDoUpdate({ target: table.id, set: row });
        } catch (_) {}
      }
      counts[tableName] = rows.length;
    };

    if (data.users?.length) await upsertRows(users, data.users, "users");
    if (data.stores?.length) await upsertRows(stores, data.stores, "stores");
    if (data.products?.length) await upsertRows(products, data.products, "products");
    if (data.orders?.length) await upsertRows(orders, data.orders, "orders");
    if (data.targets?.length) await upsertRows(targets, data.targets, "targets");
    if (data.chatMessages?.length) await upsertRows(chatMessages, data.chatMessages, "chatMessages");
    if (data.withdrawals?.length) await upsertRows(withdrawals, data.withdrawals, "withdrawals");
    if (data.merchantNotices?.length) await upsertRows(merchantNotices, data.merchantNotices, "merchantNotices");
    if (data.rechargeHistory?.length) await upsertRows(rechargeHistory, data.rechargeHistory, "rechargeHistory");
    if (data.userDailyStats?.length) await upsertRows(userDailyStats, data.userDailyStats, "userDailyStats");
    // Restore product images — most critical for store integrity
    if (data.productImages?.length) await upsertRows(productImages, data.productImages, "productImages");

    console.log(`[restore] Restore completed from ${backupFile}:`, counts);
    return { success: true, message: `Restore completed from backup dated ${data.timestamp}`, counts };
  } catch (err: any) {
    console.error("[restore] Restore failed:", err);
    return { success: false, message: err.message || "Restore failed", counts: {} };
  }
}

async function autoRestoreIfEmpty() {
  try {
    const existingUsers = await db.select().from(users);
    if (existingUsers.length > 0) return;

    const backupFile = path.join(process.cwd(), "backups", "latest_backup.json");
    if (!fs.existsSync(backupFile)) return;

    console.log("[restore] Empty database detected — auto-restoring from latest backup...");
    const result = await restoreFromBackup(backupFile);
    console.log("[restore] Auto-restore result:", result.message, result.counts);
  } catch (err) {
    console.error("[restore] Auto-restore check failed:", err);
  }
}

async function runPeriodicSync() {
  try {
    const backupFile = path.join(process.cwd(), "backups", "latest_backup.json");
    if (!fs.existsSync(backupFile)) return;

    const raw = fs.readFileSync(backupFile, "utf-8");
    const data = JSON.parse(raw);

    const [dbUsers, dbStores, dbProducts, dbOrders, dbWithdrawals, dbProductImages] = await Promise.all([
      db.select({ id: users.id }).from(users),
      db.select({ id: stores.id }).from(stores),
      db.select({ id: products.id }).from(products),
      db.select({ id: orders.id }).from(orders),
      db.select({ id: withdrawals.id }).from(withdrawals),
      db.select({ id: productImages.id }).from(productImages),
    ]);

    const dbUserIds = new Set(dbUsers.map(r => r.id));
    const dbStoreIds = new Set(dbStores.map(r => r.id));
    const dbProductIds = new Set(dbProducts.map(r => r.id));
    const dbOrderIds = new Set(dbOrders.map(r => r.id));
    const dbWithdrawalIds = new Set(dbWithdrawals.map(r => r.id));
    const dbImageIds = new Set(dbProductImages.map(r => r.id));

    const missingUsers = (data.users || []).filter((r: any) => !dbUserIds.has(r.id));
    const missingStores = (data.stores || []).filter((r: any) => !dbStoreIds.has(r.id));
    const missingProducts = (data.products || []).filter((r: any) => !dbProductIds.has(r.id));
    const missingOrders = (data.orders || []).filter((r: any) => !dbOrderIds.has(r.id));
    const missingWithdrawals = (data.withdrawals || []).filter((r: any) => !dbWithdrawalIds.has(r.id));
    // Only restore images whose product still exists in DB (to avoid FK violations)
    const missingImages = (data.productImages || []).filter((r: any) => !dbImageIds.has(r.id) && dbProductIds.has(r.productId));

    let synced = 0;
    const insertMissing = async (table: any, rows: any[]) => {
      for (const row of rows) {
        try { await db.insert(table).values(row).onConflictDoNothing(); synced++; } catch (_) {}
      }
    };

    if (missingUsers.length) await insertMissing(users, missingUsers);
    if (missingStores.length) await insertMissing(stores, missingStores);
    if (missingProducts.length) await insertMissing(products, missingProducts);
    if (missingOrders.length) await insertMissing(orders, missingOrders);
    if (missingWithdrawals.length) await insertMissing(withdrawals, missingWithdrawals);
    if (missingImages.length) await insertMissing(productImages, missingImages);

    if (synced > 0) {
      console.log(`[sync] Periodic sync restored ${synced} missing records from backup (including ${missingImages.length} images)`);
    }
  } catch (err) {
    console.error("[sync] Periodic sync failed:", err);
  }
}

// ─── Supabase rotating backup (current + previous + images) ──────────────────
//
//  Three rows are maintained in the `backups` table:
//   • label='current'  — latest full metadata snapshot (no images) — rotates on every change
//   • label='previous' — previous metadata snapshot  — kept for rollback
//   • label='images'   — latest product_images snapshot — updated only when images change
//
//  This design keeps the frequent metadata backup fast (~200KB) while the image backup
//  (~31MB) only runs when images actually change. On a full DB restore both are merged.

let _backupTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleBackup(delaySec = 5) {
  if (_backupTimer) clearTimeout(_backupTimer);
  _backupTimer = setTimeout(async () => {
    _backupTimer = null;
    try {
      const [
        dbUsers, dbStores, dbProducts, dbOrders,
        dbTargets, dbWithdrawals, dbChats, dbNotices,
        dbRecharge, dbStats, dbSettings,
      ] = await Promise.all([
        db.select().from(users),
        db.select().from(stores),
        db.select().from(products),
        db.select().from(orders),
        db.select().from(targets),
        db.select().from(withdrawals),
        db.select().from(chatMessages),
        db.select().from(merchantNotices),
        db.select().from(rechargeHistory),
        db.select().from(userDailyStats),
        db.select().from(siteSettings),
      ]);
      const payload = JSON.stringify({
        timestamp: new Date().toISOString(),
        version: 3,
        users: dbUsers, stores: dbStores, products: dbProducts,
        orders: dbOrders, targets: dbTargets, withdrawals: dbWithdrawals,
        chatMessages: dbChats, merchantNotices: dbNotices,
        rechargeHistory: dbRecharge, userDailyStats: dbStats,
        siteSettings: dbSettings,
      });
      // Rotate: delete old 'previous', promote 'current' → 'previous', insert new 'current'
      const metaRows = await db.select().from(backups).where(sql`label IN ('current','previous')`);
      const prev = metaRows.find(r => r.label === "previous");
      const curr = metaRows.find(r => r.label === "current");
      if (prev) await db.delete(backups).where(eq(backups.id, prev.id));
      if (curr) await db.update(backups).set({ label: "previous" }).where(eq(backups.id, curr.id));
      await db.insert(backups).values({ label: "current", data: payload });
      console.log(`[backup] Supabase metadata backup updated — products: ${dbProducts.length}, orders: ${dbOrders.length}`);
    } catch (err) {
      console.error("[backup] Metadata backup failed:", err);
    }
  }, delaySec * 1000);
}

// Image-only backup — runs after any image create/delete (debounced 10s)
// Stores the full product_images table as label='images' in the backups table.
let _imageBackupTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleImageBackup(delaySec = 10) {
  if (_imageBackupTimer) clearTimeout(_imageBackupTimer);
  _imageBackupTimer = setTimeout(async () => {
    _imageBackupTimer = null;
    try {
      const allImages = await db.select().from(productImages);
      const payload = JSON.stringify({
        timestamp: new Date().toISOString(),
        version: 3,
        productImages: allImages,
      });
      // Upsert label='images' (no rotation needed — always keep the latest)
      const existing = await db.select().from(backups).where(eq(backups.label, "images"));
      if (existing.length > 0) {
        await db.update(backups).set({ data: payload, createdAt: new Date() }).where(eq(backups.label, "images"));
      } else {
        await db.insert(backups).values({ label: "images", data: payload });
      }
      console.log(`[backup] Supabase image backup updated — ${allImages.length} images`);
    } catch (err) {
      console.error("[backup] Image backup failed:", err);
    }
  }, delaySec * 1000);
}

// On startup: if any products have NO matching image row at all, try to restore from
// the Supabase images backup so the store never shows broken product listings.
async function autoHealImages() {
  try {
    const allProds = await db.select({ id: products.id, imageUrl: products.imageUrl }).from(products);
    const allImgIds = new Set(
      (await db.select({ id: productImages.id }).from(productImages)).map(r => r.id)
    );
    // Products whose imageUrl points to /api/images/{id} but that id is missing
    const brokenProducts = allProds.filter(p => {
      if (!p.imageUrl) return false;
      const m = p.imageUrl.match(/\/api\/images\/([^/]+)$/);
      return m && !allImgIds.has(m[1]);
    });
    if (brokenProducts.length === 0) return;

    console.log(`[heal] Found ${brokenProducts.length} products with missing images — attempting Supabase image restore...`);
    const imgBackupRows = await db.select().from(backups).where(eq(backups.label, "images"));
    if (!imgBackupRows.length) {
      console.log("[heal] No Supabase image backup found — cannot auto-heal.");
      return;
    }
    const imageData = JSON.parse(imgBackupRows[0].data);
    const allDbProductIds = new Set(allProds.map(p => p.id));
    let healed = 0;
    for (const img of (imageData.productImages || [])) {
      if (allDbProductIds.has(img.productId)) {
        try {
          await db.insert(productImages).values(img).onConflictDoNothing();
          healed++;
        } catch (_) {}
      }
    }
    console.log(`[heal] Auto-healed ${healed} product images from Supabase backup.`);
  } catch (err) {
    console.error("[heal] Image auto-heal failed:", err);
  }
}

async function migrateFileImagesToBase64() {
  try {
    const allProducts = await db.select().from(products);
    let migrated = 0;
    for (const product of allProducts) {
      const updates: any = {};
      if (product.imageUrl && product.imageUrl.startsWith("/uploads/")) {
        const filePath = path.join(process.cwd(), product.imageUrl);
        if (fs.existsSync(filePath)) {
          const buffer = fs.readFileSync(filePath);
          const ext = path.extname(filePath).toLowerCase().replace(".", "");
          const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
          updates.imageUrl = `data:${mime};base64,${buffer.toString("base64")}`;
        }
      }
      if (product.images && product.images.length > 0) {
        const newImages = [];
        let changed = false;
        for (const imgUrl of product.images) {
          if (imgUrl && imgUrl.startsWith("/uploads/")) {
            const filePath = path.join(process.cwd(), imgUrl);
            if (fs.existsSync(filePath)) {
              const buffer = fs.readFileSync(filePath);
              const ext = path.extname(filePath).toLowerCase().replace(".", "");
              const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
              newImages.push(`data:${mime};base64,${buffer.toString("base64")}`);
              changed = true;
            } else {
              newImages.push(imgUrl);
            }
          } else {
            newImages.push(imgUrl);
          }
        }
        if (changed) updates.images = newImages;
      }
      if (Object.keys(updates).length > 0) {
        await db.update(products).set(updates).where(eq(products.id, product.id));
        migrated++;
      }
    }

    const allStores = await db.select().from(stores);
    for (const store of allStores) {
      const updates: any = {};
      if (store.logoUrl && store.logoUrl.startsWith("/uploads/")) {
        const filePath = path.join(process.cwd(), store.logoUrl);
        if (fs.existsSync(filePath)) {
          const buffer = fs.readFileSync(filePath);
          const ext = path.extname(filePath).toLowerCase().replace(".", "");
          const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
          updates.logoUrl = `data:${mime};base64,${buffer.toString("base64")}`;
          migrated++;
        }
      }
      if (store.nicImageUrl && store.nicImageUrl.startsWith("/uploads/")) {
        const filePath = path.join(process.cwd(), store.nicImageUrl);
        if (fs.existsSync(filePath)) {
          const buffer = fs.readFileSync(filePath);
          const ext = path.extname(filePath).toLowerCase().replace(".", "");
          const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
          updates.nicImageUrl = `data:${mime};base64,${buffer.toString("base64")}`;
          migrated++;
        }
      }
      if (Object.keys(updates).length > 0) {
        await db.update(stores).set(updates as any).where(eq(stores.id, store.id));
      }
    }

    if (migrated > 0) {
      console.log(`[migrate] Migrated ${migrated} file-based image(s) to base64 in database`);
    }
  } catch (err) {
    console.error("[migrate] Image migration failed:", err);
  }
}

const PgSession = connectPgSimple(session);

function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password + "marketplacesalt").digest("hex");
}

// ─── Image storage helpers ───────────────────────────────────────────────────
// Base64 images are stored in the product_images table so product rows stay
// small (only a tiny URL reference is kept).  Any existing URL is passed
// through unchanged – only data: URIs are persisted to the table.

async function storeImage(productId: string, dataUri: string, position: number): Promise<string> {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return dataUri; // not a valid data URI – return as-is
  const mimeType = match[1];
  const base64Data = match[2];
  const [row] = await db.insert(productImages).values({ productId, data: base64Data, mimeType, position }).returning({ id: productImages.id });
  // Schedule image backup 10 s after the last image change
  scheduleImageBackup(10);
  return `/api/images/${row.id}`;
}

async function processProductImages(productId: string, data: any): Promise<any> {
  const out = { ...data };
  if (out.imageUrl && typeof out.imageUrl === "string" && out.imageUrl.startsWith("data:")) {
    out.imageUrl = await storeImage(productId, out.imageUrl, 0);
  }
  if (Array.isArray(out.images)) {
    const processed: string[] = [];
    for (let i = 0; i < out.images.length; i++) {
      const img = out.images[i];
      if (img && typeof img === "string") {
        processed.push(img.startsWith("data:") ? await storeImage(productId, img, i + 1) : img);
      }
    }
    out.images = processed.length > 0 ? processed : null;
  }
  return out;
}

// Synchronous pre-filter – strips base64 before Zod parsing (for create routes
// where we don't yet have a product ID; images are saved in a second pass).
function stripBase64(data: any): { cleaned: any; base64ImageUrl: string | null; base64Images: string[] } {
  const cleaned = { ...data };
  const base64ImageUrl = (cleaned.imageUrl && typeof cleaned.imageUrl === "string" && cleaned.imageUrl.startsWith("data:")) ? cleaned.imageUrl : null;
  const base64Images: string[] = [];
  if (base64ImageUrl) cleaned.imageUrl = null;
  if (Array.isArray(cleaned.images)) {
    const kept: string[] = [];
    for (const img of cleaned.images) {
      if (img && typeof img === "string" && img.startsWith("data:")) base64Images.push(img);
      else if (img) kept.push(img);
    }
    cleaned.images = kept.length > 0 ? kept : null;
  }
  return { cleaned, base64ImageUrl, base64Images };
}

async function applyPendingImages(productId: string, base64ImageUrl: string | null, base64Images: string[], existingImageUrl?: string | null): Promise<{ imageUrl?: string; images?: string[] | null }> {
  const updates: { imageUrl?: string; images?: string[] | null } = {};
  if (base64ImageUrl) {
    updates.imageUrl = await storeImage(productId, base64ImageUrl, 0);
  }
  if (base64Images.length > 0) {
    const storedUrls = await Promise.all(base64Images.map((img, i) => storeImage(productId, img, i + 1)));
    updates.images = storedUrls;
  }
  return updates;
}

function isAuthenticated(req: Request, res: Response, next: any) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ message: "Unauthorized" });
}

function isAdmin(req: Request, res: Response, next: any) {
  const role = (req.user as any)?.role;
  if (req.isAuthenticated() && (role === "admin" || role === "superadmin")) return next();
  res.status(403).json({ message: "Forbidden" });
}

function isSuperAdmin(req: Request, res: Response, next: any) {
  if (req.isAuthenticated() && (req.user as any)?.role === "superadmin") return next();
  res.status(403).json({ message: "Forbidden" });
}

function generateReferenceCode(): string {
  return "REF-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

async function getLinkedUserIds(req: Request): Promise<string[] | null> {
  const role = (req.user as any)?.role;
  if (role === "superadmin") return null;
  const adminId = (req.user as any)?.id;
  const allUsers = await storage.getAllUsers();
  return allUsers.filter(u => u.referredBy === adminId).map(u => u.id);
}

function isNotFrozen(req: Request, res: Response, next: any) {
  if ((req.user as any)?.isFrozen) {
    return res.status(403).json({ message: "Account is frozen. Please contact admin." });
  }
  next();
}

const clients = new Map<string, WebSocket>();

function broadcastAll(data: object) {
  const msg = JSON.stringify(data);
  for (const ws of clients.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

async function notifyDataSync(entity: string, action: string, id?: string) {
  try {
    const payload = JSON.stringify({ entity, action, id, ts: Date.now() });
    await db.execute(sql`SELECT pg_notify('data_sync', ${payload})`);
  } catch (err) {
    console.error("[sync] pg_notify failed:", err);
  }
  // Schedule a Supabase backup 5 s after the last change (debounced)
  scheduleBackup(5);
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  const isProduction = process.env.NODE_ENV === "production";

  // Note: DB connections are managed exclusively by the shared pool in storage.ts.

  if (isProduction) {
    app.set("trust proxy", 1);
  }

  // Multi-domain CORS: dynamically reflect any incoming origin so all connected
  // custom domains can make credentialed requests (login sessions, cookies, etc.)
  app.use(cors({
    origin: (origin, callback) => {
      // Allow same-origin requests (no Origin header) and any external origin
      callback(null, origin || true);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    exposedHeaders: ["Set-Cookie"],
    maxAge: 86400,
  }));

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://fonts.googleapis.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com",
        "font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com data:",
        "img-src 'self' data: blob: https:",
        "connect-src 'self' wss: ws: https:",
        "frame-ancestors 'self'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; ")
    );
    if (isProduction) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
    }
    next();
  });

  // Simple in-memory rate limiter for login — prevents brute-force and Cloudflare WAF triggers
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  function loginRateLimit(req: Request, res: Response, next: any) {
    const ip = (req.headers["x-forwarded-for"] as string || req.socket.remoteAddress || "unknown").split(",")[0].trim();
    const now = Date.now();
    const windowMs = 15 * 60 * 1000; // 15-minute window
    const maxAttempts = 15;
    const entry = loginAttempts.get(ip);
    if (!entry || now > entry.resetAt) {
      loginAttempts.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count++;
    if (entry.count > maxAttempts) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ message: "Too many login attempts. Please wait 15 minutes before trying again." });
    }
    next();
  }
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of loginAttempts) {
      if (now > entry.resetAt) loginAttempts.delete(ip);
    }
  }, 5 * 60 * 1000);

  // Health check endpoint — for monitoring and uptime services
  app.get("/api/health", async (_req, res) => {
    try {
      await db.execute(sql`SELECT 1`);
      res.json({ status: "ok", timestamp: new Date().toISOString(), uptime: process.uptime() });
    } catch {
      res.status(503).json({ status: "error", timestamp: new Date().toISOString() });
    }
  });

  // Sitemap.xml — helps Google discover and index all public pages
  app.get("/sitemap.xml", (req, res) => {
    const base = `${req.protocol}://${req.get("host")}`;
    const pages = [
      { url: "/", priority: "1.0", changefreq: "daily" },
      { url: "/about", priority: "0.8", changefreq: "monthly" },
      { url: "/contact", priority: "0.7", changefreq: "monthly" },
      { url: "/privacy", priority: "0.5", changefreq: "yearly" },
      { url: "/terms", priority: "0.5", changefreq: "yearly" },
    ];
    const today = new Date().toISOString().split("T")[0];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(p => `  <url>
    <loc>${base}${p.url}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join("\n")}
</urlset>`;
    res.setHeader("Content-Type", "application/xml");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(xml);
  });

  // Public image serving – serves product images stored in product_images table
  app.get("/api/images/:id", async (req, res) => {
    try {
      const [img] = await db.select().from(productImages).where(eq(productImages.id, req.params.id));
      if (!img) return res.status(404).json({ message: "Image not found" });
      const buffer = Buffer.from(img.data, "base64");
      res.setHeader("Content-Type", img.mimeType);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Content-Length", buffer.length);
      res.end(buffer);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.use(session({
    store: new PgSession({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || "marketplace-secret-2024",
    resave: false,
    saveUninitialized: false,
    name: "mkt.sid",
    cookie: {
      secure: isProduction,
      httpOnly: true,
      sameSite: isProduction ? "none" : "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }));

  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(new LocalStrategy({ usernameField: "email" }, async (email, password, done) => {
    try {
      const user = await storage.getUserByEmail(email);
      if (!user) return done(null, false, { message: "Invalid credentials" });
      if (user.password !== hashPassword(password)) return done(null, false, { message: "Invalid credentials" });
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }));

  passport.serializeUser((user: any, done) => done(null, user.id));
  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await storage.getUser(id);
      done(null, user);
    } catch (err) {
      done(err);
    }
  });

  // Serve uploaded files (legacy support for existing file-based images)
  const express = await import("express");
  app.use("/uploads", express.default.static("uploads"));

  app.post("/api/upload", isAuthenticated, isAdmin, upload.single("image"), (req: any, res) => {
    if (!req.file) return res.status(400).json({ message: "No file uploaded or invalid file type" });
    const base64 = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype;
    const imageUrl = `data:${mimeType};base64,${base64}`;
    res.json({ imageUrl });
  });

  app.post("/api/upload/nic", upload.single("image"), (req: any, res) => {
    if (!req.file) return res.status(400).json({ message: "No file uploaded or invalid file type" });
    const base64 = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype;
    const imageUrl = `data:${mimeType};base64,${base64}`;
    res.json({ imageUrl });
  });

  // Migrate existing file-based images to base64 in the database
  migrateFileImagesToBase64();

  // Auto-restore from backup if database is empty (new deployment/domain)
  await autoRestoreIfEmpty();

  // Auto-heal: if products exist but their images are missing, restore from Supabase image backup
  setTimeout(() => autoHealImages(), 3000);

  // Take an initial Supabase image backup shortly after startup to ensure it's always current
  scheduleImageBackup(15);

  // Health check endpoint for uptime monitoring
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString(), uptime: process.uptime() });
  });

  // Auth routes
  app.post("/api/auth/register", async (req, res) => {
    try {
      const parsed = insertUserSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid data", errors: parsed.error.errors });

      const existing = await storage.getUserByEmail(parsed.data.email);
      if (existing) return res.status(400).json({ message: "Email already in use" });

      const existingUsername = await storage.getUserByUsername(parsed.data.username);
      if (existingUsername) return res.status(400).json({ message: "Username already taken" });

      const user = await storage.createUser({
        ...parsed.data,
        password: hashPassword(parsed.data.password),
      });

      scheduleBackup(5);
      req.login(user, (err) => {
        if (err) return res.status(500).json({ message: "Login failed after registration" });
        const { password, ...safeUser } = user;
        res.json(safeUser);
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/auth/login", loginRateLimit, (req, res, next) => {
    passport.authenticate("local", (err: any, user: any, info: any) => {
      if (err) return next(err);
      if (!user) return res.status(401).json({ message: info?.message || "Invalid credentials" });
      req.login(user, (err) => {
        if (err) return next(err);
        const { password, ...safeUser } = user;
        res.json(safeUser);
      });
    })(req, res, next);
  });

  app.post("/api/auth/logout", (req, res) => {
    req.logout(() => res.json({ message: "Logged out" }));
  });

  app.get("/api/auth/me", isAuthenticated, (req, res) => {
    const { password, ...safeUser } = req.user as any;
    res.json(safeUser);
  });

  app.patch("/api/users/profile", isAuthenticated, isNotFrozen, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const { username, password, confirmPassword, phone, profession, age } = req.body;
      const updateData: any = {};

      if (username && username !== (req.user as any).username) {
        const allUsers = await storage.getAllUsers();
        const taken = allUsers.find(u => u.username === username && u.id !== userId);
        if (taken) return res.status(400).json({ message: "Username already taken" });
        updateData.username = username;
      }
      if (password) {
        if (password.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });
        if (password !== confirmPassword) return res.status(400).json({ message: "Passwords do not match" });
        updateData.password = hashPassword(password);
      }
      if (phone !== undefined) updateData.phone = phone;
      if (profession) updateData.profession = profession;
      if (age) updateData.age = parseInt(age);

      if (Object.keys(updateData).length === 0) return res.status(400).json({ message: "No changes provided" });

      const updated = await storage.updateUser(userId, updateData);
      if (!updated) return res.status(404).json({ message: "User not found" });
      const { password: pw, ...safeUser } = updated;
      res.json(safeUser);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Users routes (admin)
  app.get("/api/users", isAuthenticated, isAdmin, async (req, res) => {
    const allUsers = await storage.getAllUsers();
    const currentUser = req.user as any;
    let filtered = allUsers;
    if (currentUser.role === "admin") {
      filtered = allUsers.filter(u => u.referredBy === currentUser.id || u.id === currentUser.id);
    }
    res.json(filtered.map(({ password, ...u }) => u));
  });

  app.patch("/api/users/:id/freeze", isAuthenticated, isAdmin, async (req, res) => {
    const linkedIds = await getLinkedUserIds(req);
    if (linkedIds !== null && !linkedIds.includes(req.params.id)) {
      return res.status(403).json({ message: "You can only manage your own linked customers" });
    }
    const user = await storage.updateUserFrozen(req.params.id, req.body.isFrozen);
    if (!user) return res.status(404).json({ message: "User not found" });
    notifyDataSync("users", "update", req.params.id);
    const { password, ...safeUser } = user;
    res.json(safeUser);
  });

  // Stores routes
  app.get("/api/stores", async (req, res) => {
    const allStores = await storage.getAllStores();
    res.json(allStores);
  });

  app.get("/api/stores/my", isAuthenticated, async (req, res) => {
    const userId = (req.user as any).id;
    const myStores = await storage.getStoresByOwner(userId);
    res.json(myStores);
  });

  app.get("/api/stores/:id", async (req, res) => {
    const store = await storage.getStore(req.params.id);
    if (!store) return res.status(404).json({ message: "Store not found" });
    res.json(store);
  });

  app.post("/api/stores", isAuthenticated, isNotFrozen, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const existingStores = await storage.getStoresByOwner(userId);
      if (existingStores.length > 0) {
        return res.status(400).json({ message: "You can only create one store per account" });
      }
      if (!req.body.nicImageUrl) {
        return res.status(400).json({ message: "NIC image is required for store registration" });
      }
      if (!req.body.referenceCode) {
        return res.status(400).json({ message: "Reference code is required for store registration" });
      }
      const allUsers = await storage.getAllUsers();
      const referringAdmin = allUsers.find(u => u.referenceCode === req.body.referenceCode && (u.role === "admin" || u.role === "superadmin"));
      if (!referringAdmin) {
        return res.status(400).json({ message: "Invalid reference code. Please enter a valid admin reference code." });
      }
      await storage.updateUser(userId, { referredBy: referringAdmin.id } as any);
      const parsed = insertStoreSchema.safeParse({ ...req.body, ownerId: userId });
      if (!parsed.success) return res.status(400).json({ message: "Invalid data", errors: parsed.error.errors });
      const store = await storage.createStore({ ...parsed.data, isApproved: false } as any);
      notifyDataSync("stores", "create", store.id);
      res.json(store);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/stores/:id", isAuthenticated, isNotFrozen, async (req, res) => {
    const store = await storage.getStore(req.params.id);
    if (!store) return res.status(404).json({ message: "Store not found" });
    if (store.ownerId !== (req.user as any).id && (req.user as any).role !== "admin") {
      return res.status(403).json({ message: "Forbidden" });
    }
    const updated = await storage.updateStore(req.params.id, req.body);
    notifyDataSync("stores", "update", req.params.id);
    res.json(updated);
  });

  app.delete("/api/stores/:id", isAuthenticated, async (req, res) => {
    const store = await storage.getStore(req.params.id);
    if (!store) return res.status(404).json({ message: "Store not found" });
    if (store.ownerId !== (req.user as any).id && (req.user as any).role !== "admin") {
      return res.status(403).json({ message: "Forbidden" });
    }
    await storage.deleteStore(req.params.id);
    notifyDataSync("stores", "delete", req.params.id);
    res.json({ message: "Store deleted" });
  });

  app.patch("/api/stores/:id/visitors", isAuthenticated, isAdmin, async (req, res) => {
    const store = await storage.getStore(req.params.id);
    if (!store) return res.status(404).json({ message: "Store not found" });
    const visitors = parseInt(req.body.visitors);
    if (isNaN(visitors) || visitors < 0) return res.status(400).json({ message: "Invalid visitor count" });
    const updated = await storage.updateStoreVisitors(req.params.id, visitors);
    const ownerUpdate: any = {};
    if (req.body.rating !== undefined) {
      const v = parseFloat(req.body.rating);
      if (!isNaN(v) && v >= 0 && v <= 5) ownerUpdate.rating = v.toFixed(1);
    }
    if (req.body.grade !== undefined) {
      const v = parseFloat(req.body.grade);
      if (!isNaN(v) && v >= 0) ownerUpdate.grade = v.toFixed(1);
    }
    if (req.body.credit !== undefined) {
      const v = parseInt(req.body.credit);
      if (!isNaN(v) && v >= 0) ownerUpdate.credit = v;
    }
    if (req.body.goodRate !== undefined) {
      const v = parseFloat(req.body.goodRate);
      if (!isNaN(v) && v >= 0 && v <= 100) ownerUpdate.goodRate = v.toFixed(2);
    }
    if (req.body.vipLevel !== undefined) {
      const v = parseInt(req.body.vipLevel);
      if (!isNaN(v) && v >= 1 && v <= 10) ownerUpdate.vipLevel = v;
    }
    if (Object.keys(ownerUpdate).length > 0) {
      await storage.updateUser(store.ownerId, ownerUpdate);
    }
    res.json(updated);
  });

  app.get("/api/admin/catalog-store", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const allStores = await storage.getAllStores();
      const allUsers = await storage.getAllUsers();
      let adminStore = allStores.find(s => {
        const owner = allUsers.find(u => u.id === s.ownerId);
        return owner?.role === "admin" || owner?.role === "superadmin";
      });
      if (!adminStore) {
        const adminUser = await storage.getAdminUser();
        if (!adminUser) return res.status(500).json({ message: "No admin user found" });
        adminStore = await storage.createStore({
          ownerId: adminUser.id,
          name: "MarketHub Official",
          description: "Official marketplace catalog. Browse and resell curated products.",
          category: "General",
        });
      }
      res.json(adminStore);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // CSV template download for bulk product import
  app.get("/api/admin/products/template", isAuthenticated, isAdmin, (req, res) => {
    const headers = ["name", "description", "details", "detailedDescription", "price", "costPrice", "category", "stock", "image", "image2", "image3", "image4", "image5"];
    const example = [
      "Premium Wireless Headphones",
      "High quality over-ear headphones with noise cancellation",
      "40hr battery • Bluetooth 5.3 • Foldable design",
      "Experience crystal-clear audio with our premium headphones featuring active noise cancellation technology.",
      "49.99",
      "25.00",
      "Electronics",
      "100",
      "headphones.jpg",
      "headphones_side.jpg",
      "headphones_case.jpg",
      "",
      "",
    ];
    const csv = [headers.join(","), example.map(v => `"${v.replace(/"/g, '""')}"`).join(",")].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=\"products_template.csv\"");
    res.send(csv);
  });

  // ZIP template download (CSV + sample images)
  app.get("/api/admin/products/template-zip", isAuthenticated, isAdmin, (req, res) => {
    // 3 rows of sample data
    // Each product can have up to 5 images: image (main) + image2..image5 (gallery)
    const rows = [
      ["name","description","details","detailedDescription","price","costPrice","category","stock","image","image2","image3","image4","image5"],
      ["Wireless Earbuds","High quality wireless earbuds with noise cancellation","6hr battery • Bluetooth 5.3 • IPX4 waterproof","Experience rich, clear audio with deep bass and active noise cancellation for immersive listening.","29.99","12.00","Audio","100","earbuds_main.jpg","earbuds_side.jpg","earbuds_case.jpg","",""],
      ["Leather Tote Bag","Genuine leather tote bag for everyday use","Full-grain leather • 3 inner pockets • Magnetic clasp","Crafted from premium full-grain leather, this spacious tote offers durability and timeless style.","59.99","28.00","Fashion","50","bag_main.jpg","bag_inside.jpg","","",""],
      ["LED Desk Lamp","Modern LED desk lamp with adjustable brightness","5 brightness levels • USB charging port • Touch control","This sleek LED lamp provides eye-friendly illumination with a built-in USB port for convenient device charging.","24.99","10.00","Electronics","75","lamp_main.jpg","lamp_on.jpg","lamp_detail.jpg","lamp_port.jpg",""],
    ];
    const csvLines = rows.map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(","));
    const csvBuffer = Buffer.from(csvLines.join("\n"), "utf8");

    // Tiny distinct placeholder PNGs (1×1 pixels, different colours per slot)
    const placeholderPng = (key: string): Buffer => {
      const pngBase64Map: Record<string, string> = {
        blue:    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        green:   "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        orange:  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==",
        red:     "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
        purple:  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=",
        teal:    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkmP+/HgAHcAJ9VtVLcwAAAABJRU5ErkJggg==",
        pink:    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8ZQDwADggGB4HNiTwAAAABJRU5ErkJggg==",
        yellow:  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8dQDwADhQGAWjR9awAAAABJRU5ErkJggg==",
      };
      return Buffer.from(pngBase64Map[key] || pngBase64Map.blue, "base64");
    };

    const readme = `MarketNest Product Import Template
===================================

HOW TO USE THIS ZIP FILE:
1. Open products.csv in Excel, Google Sheets, or any spreadsheet app
2. Replace the 3 sample rows with your own products
3. Fill in image filenames for each product (see column guide below)
4. Add ALL your image files into this same folder (ZIP root)
5. Compress everything back into a single .zip file
6. Upload the ZIP via Admin Panel → Catalog → Import CSV / ZIP

IMAGE COLUMNS — Each product supports up to 5 images:
┌─────────┬────────────────────────────────────────────────────┐
│ Column  │ Purpose                                            │
├─────────┼────────────────────────────────────────────────────┤
│ image   │ MAIN product photo (shown on cards & first in      │
│         │ product page gallery)                              │
│ image2  │ Gallery photo 2                                    │
│ image3  │ Gallery photo 3                                    │
│ image4  │ Gallery photo 4                                    │
│ image5  │ Gallery photo 5                                    │
└─────────┴────────────────────────────────────────────────────┘
Leave any image column blank if you have fewer than 5 photos.

EXAMPLE (in your CSV):
  image        → shirt_front.jpg
  image2       → shirt_back.jpg
  image3       → shirt_detail.jpg
  image4       → (leave blank)
  image5       → (leave blank)

OTHER COLUMNS:
- name             : Product name (required)
- description      : Short description shown on product card
- details          : Bullet points / highlights (use • to separate)
- detailedDescription : Full long description on product page
- price            : Selling price, e.g. 29.99 (required, must be > 0)
- costPrice        : Your cost/buy price, e.g. 12.00
- category         : One of: Electronics, Audio, Accessories, Fashion,
                     Books, Home & Garden, Beauty, Sports, Toys, Other
- stock            : Number of units available, e.g. 100

SUPPORTED IMAGE FORMATS: .jpg  .jpeg  .png  .gif  .webp
MAX ZIP FILE SIZE: 50 MB

TIPS:
- Keep filenames simple, no spaces (use underscores: my_shirt_front.jpg)
- Images can be in the ZIP root OR inside an "images/" subfolder
- The placeholder images in this template are tiny colour squares —
  replace them with your real product photos before importing.
`;

    const zip = new AdmZip();
    zip.addFile("products.csv", csvBuffer);
    // Row 1 — Earbuds: 3 images
    zip.addFile("earbuds_main.jpg",  placeholderPng("blue"));
    zip.addFile("earbuds_side.jpg",  placeholderPng("teal"));
    zip.addFile("earbuds_case.jpg",  placeholderPng("purple"));
    // Row 2 — Bag: 2 images
    zip.addFile("bag_main.jpg",   placeholderPng("orange"));
    zip.addFile("bag_inside.jpg", placeholderPng("yellow"));
    // Row 3 — Lamp: 4 images
    zip.addFile("lamp_main.jpg",   placeholderPng("green"));
    zip.addFile("lamp_on.jpg",     placeholderPng("red"));
    zip.addFile("lamp_detail.jpg", placeholderPng("pink"));
    zip.addFile("lamp_port.jpg",   placeholderPng("teal"));
    zip.addFile("README.txt", Buffer.from(readme, "utf8"));

    const zipBuffer = zip.toBuffer();
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=\"marketnest_import_template.zip\"");
    res.send(zipBuffer);
  });

  // Full product export — streaming ZIP with products.csv + all images (batched 20 at a time)
  app.get("/api/admin/products/export", isAuthenticated, isAdmin, async (req, res) => {
    const safePrefix = (name: string, idx: number) =>
      name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || `product_${idx + 1}`;
    const mimeToExt: Record<string, string> = {
      "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
      "image/gif": "gif", "image/webp": "webp",
    };

    try {
      const allProducts = await storage.getAdminProducts();
      const productIds = allProducts.map(p => p.id);

      // Step 1: Fetch image METADATA only (no base64 data) — lightweight, just for building filenames
      const imgMeta = productIds.length > 0
        ? await db.select({
            id: productImages.id,
            productId: productImages.productId,
            mimeType: productImages.mimeType,
            position: productImages.position,
          }).from(productImages).where(inArray(productImages.productId, productIds))
        : [];

      // Build product → sorted metadata map
      const imgMetaByProduct = new Map<string, typeof imgMeta>();
      for (const m of imgMeta) {
        if (!imgMetaByProduct.has(m.productId)) imgMetaByProduct.set(m.productId, []);
        imgMetaByProduct.get(m.productId)!.push(m);
      }
      for (const [, rows] of imgMetaByProduct) rows.sort((a, b) => a.position - b.position);

      // Step 2: Build filename map (imageId → path in zip) and CSV rows
      const idToFilename = new Map<string, string>();
      const usedFilenames = new Set<string>();
      const headers = ["name","description","details","detailedDescription","price","costPrice","category","stock","image","image2","image3","image4","image5"];
      const csvRows: string[][] = [headers];

      for (let pi = 0; pi < allProducts.length; pi++) {
        const p = allProducts[pi];
        const prefix = safePrefix(p.name, pi);
        const metas = imgMetaByProduct.get(p.id) || [];
        const imageFilenames: string[] = [];

        for (const meta of metas) {
          const ext = mimeToExt[meta.mimeType] || "jpg";
          const slot = meta.position === 0 ? "main" : `gallery${meta.position}`;
          let fname = `${prefix}_${slot}.${ext}`;
          let attempt = 0;
          while (usedFilenames.has(fname)) fname = `${prefix}_${pi + 1}_${slot}_${++attempt}.${ext}`;
          usedFilenames.add(fname);
          imageFilenames[meta.position] = fname;
          idToFilename.set(meta.id, fname);
        }

        const slots = [0,1,2,3,4].map(pos => imageFilenames[pos] || "");
        csvRows.push([
          p.name, p.description || "", (p as any).details || "", p.detailedDescription || "",
          parseFloat(p.price).toFixed(2), parseFloat(p.costPrice || "0").toFixed(2),
          p.category, String(p.stock ?? 0), ...slots,
        ]);
      }

      const sanitize = (v: string) => String(v).replace(/[\r\n]+/g, " ").replace(/"/g, '""');
      const csvText = csvRows.map(row => row.map(v => `"${sanitize(v)}"`).join(",")).join("\n");

      const readme = `MarketNest Product Export
=========================
Exported: ${new Date().toUTCString()}
Products: ${allProducts.length}

This ZIP contains:
  products.csv  — all your product data (ready to re-import)
  images/       — all product images referenced in the CSV

You can edit products.csv, add/swap images, then re-upload this ZIP
via Admin Panel → Catalog → Import CSV / ZIP.

IMAGE COLUMNS:
  image   = main product photo
  image2  = gallery photo 2
  image3  = gallery photo 3
  image4  = gallery photo 4
  image5  = gallery photo 5

Leave any image cell blank if no photo exists for that slot.
`;

      // Step 3: Stream the ZIP response — headers must be sent before any async image fetching
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="marketnest_export_${timestamp}.zip"`);

      const archive = archiver("zip", { zlib: { level: 1 } });
      archive.on("error", (err) => {
        console.error("[export] archive error:", err.message);
        if (!res.headersSent) res.status(500).json({ message: err.message });
        else res.destroy();
      });
      archive.pipe(res);

      // Add CSV and README immediately
      archive.append(Buffer.from(csvText, "utf8"), { name: "products.csv" });
      archive.append(Buffer.from(readme, "utf8"), { name: "README.txt" });

      // Step 4: Fetch and append images in batches of 20 (only ~1MB in memory at a time)
      const allImageIds = [...idToFilename.keys()];
      const BATCH = 20;
      for (let i = 0; i < allImageIds.length; i += BATCH) {
        const batchIds = allImageIds.slice(i, i + BATCH);
        const rows = await db.select({ id: productImages.id, data: productImages.data })
          .from(productImages).where(inArray(productImages.id, batchIds));
        for (const row of rows) {
          const fname = idToFilename.get(row.id);
          if (fname) archive.append(Buffer.from(row.data, "base64"), { name: `images/${fname}` });
        }
      }

      await archive.finalize();
    } catch (err: any) {
      console.error("[export] Error:", err.message);
      if (!res.headersSent) res.status(500).json({ message: err.message });
    }
  });

  // Bulk CSV / ZIP product import
  app.post("/api/admin/products/import", isAuthenticated, isAdmin, uploadCsv.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const allStores = await storage.getAllStores();
      const allUsers = await storage.getAllUsers();
      let adminStore = allStores.find(s => {
        const owner = allUsers.find(u => u.id === s.ownerId);
        return owner?.role === "admin" || owner?.role === "superadmin";
      });
      if (!adminStore) return res.status(404).json({ message: "Admin store not found" });

      // Determine if file is ZIP or CSV
      const ext = path.extname(req.file.originalname).toLowerCase();
      const isZip = ext === ".zip"
        || req.file.mimetype === "application/zip"
        || req.file.mimetype === "application/x-zip-compressed"
        || (req.file.buffer[0] === 0x50 && req.file.buffer[1] === 0x4B); // PK magic bytes

      let csvText = "";
      const imageMap: Map<string, Buffer> = new Map(); // filename (lowercased) -> buffer

      if (isZip) {
        const zip = new AdmZip(req.file.buffer);
        const entries = zip.getEntries();
        let csvEntry: AdmZip.IZipEntry | undefined;

        for (const entry of entries) {
          if (entry.isDirectory) continue;
          const name = entry.name.toLowerCase();
          const entryExt = path.extname(name);

          if (entryExt === ".csv") {
            // Pick the first CSV found (prefer "products.csv" if multiple)
            if (!csvEntry || name === "products.csv") csvEntry = entry;
          } else if (/\.(jpg|jpeg|png|gif|webp)$/.test(entryExt)) {
            // Store by just the filename (no path), lowercased
            imageMap.set(name, entry.getData());
            // Also store by full relative path in case CSV references it
            imageMap.set(entry.entryName.toLowerCase(), entry.getData());
          }
        }

        if (!csvEntry) return res.status(400).json({ message: "No CSV file found inside the ZIP. Include a products.csv file." });
        csvText = csvEntry.getData().toString("utf8");
      } else {
        csvText = req.file.buffer.toString("utf8");
      }

      csvText = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const lines = csvText.split("\n").filter(l => l.trim());
      if (lines.length < 2) return res.status(400).json({ message: "CSV must have a header row and at least one product row" });

      function parseCSVLine(line: string): string[] {
        const result: string[] = [];
        let current = "";
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
            else { inQuotes = !inQuotes; }
          } else if (ch === ',' && !inQuotes) {
            result.push(current.trim());
            current = "";
          } else {
            current += ch;
          }
        }
        result.push(current.trim());
        return result;
      }

      const headerRow = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9]/g, ""));
      const idx = (name: string) => {
        const aliases: Record<string, string[]> = {
          name: ["name", "productname", "title"],
          description: ["description", "desc", "shortdesc"],
          details: ["details", "highlights", "bullets"],
          detailedDescription: ["detaileddescription", "longdesc", "fulldescription", "detail"],
          price: ["price", "sellingprice", "saleprice"],
          costPrice: ["costprice", "cost", "buyprice"],
          category: ["category", "cat", "type"],
          stock: ["stock", "quantity", "qty", "inventory"],
          image:  ["image", "imageurl", "img", "photo", "filename", "imagefile", "image1"],
          image2: ["image2", "img2", "photo2", "gallery1"],
          image3: ["image3", "img3", "photo3", "gallery2"],
          image4: ["image4", "img4", "photo4", "gallery3"],
          image5: ["image5", "img5", "photo5", "gallery4"],
        };
        const alts = aliases[name] || [name.toLowerCase()];
        for (const alt of alts) {
          const i = headerRow.findIndex(h => h === alt);
          if (i !== -1) return i;
        }
        return -1;
      };

      const nameIdx = idx("name");
      if (nameIdx === -1) return res.status(400).json({ message: "CSV must have a 'name' column" });

      const categories = ["Electronics", "Audio", "Accessories", "Fashion", "Books", "Home & Garden", "Beauty", "Sports", "Toys", "Other"];
      const created: any[] = [];
      const errors: string[] = [];

      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        const name = cols[nameIdx]?.trim();
        if (!name) continue;

        const price = parseFloat(cols[idx("price")] || "0") || 0;
        const costPrice = parseFloat(cols[idx("costPrice")] || "0") || 0;
        const stock = parseInt(cols[idx("stock")] || "0") || 0;
        let category = cols[idx("category")]?.trim() || "Other";
        if (!categories.includes(category)) category = "Other";
        const description = cols[idx("description")]?.trim() || "";
        const details = cols[idx("details")]?.trim() || "";
        const detailedDescription = cols[idx("detailedDescription")]?.trim() || "";
        // Collect all 5 image slots from CSV
        const imageFilenames = [
          cols[idx("image")]?.trim().toLowerCase()  || "",
          cols[idx("image2")]?.trim().toLowerCase() || "",
          cols[idx("image3")]?.trim().toLowerCase() || "",
          cols[idx("image4")]?.trim().toLowerCase() || "",
          cols[idx("image5")]?.trim().toLowerCase() || "",
        ];

        if (price <= 0) { errors.push(`Row ${i + 1}: "${name}" skipped — price must be > 0`); continue; }

        try {
          const parsed = insertProductSchema.safeParse({
            storeId: adminStore.id,
            name,
            description,
            details,
            detailedDescription,
            price: price.toString(),
            costPrice: costPrice.toString(),
            category,
            stock,
            imageUrl: null,
            isAdminProduct: true,
            isActive: true,
          });
          if (!parsed.success) {
            errors.push(`Row ${i + 1}: "${name}" skipped — ${parsed.error.errors.map(e => e.message).join(", ")}`);
            continue;
          }
          let product = await storage.createProduct(parsed.data);

          // Helper: resolve image buffer from ZIP map (try exact name then basename)
          const resolveImg = (filename: string): Buffer | undefined => {
            if (!filename || imageMap.size === 0) return undefined;
            return imageMap.get(filename) || imageMap.get(path.basename(filename).toLowerCase());
          };

          const toDataUri = (filename: string, buf: Buffer): string => {
            const ext2 = path.extname(filename).replace(".", "").toLowerCase() || "jpeg";
            const mimeMap: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
            return `data:${mimeMap[ext2] || "image/jpeg"};base64,${buf.toString("base64")}`;
          };

          // Store main image (position 0 → imageUrl)
          const mainBuf = resolveImg(imageFilenames[0]);
          if (mainBuf) {
            const storedUrl = await storeImage(product.id, toDataUri(imageFilenames[0], mainBuf), 0);
            product = (await storage.updateProduct(product.id, { imageUrl: storedUrl })) ?? product;
          }

          // Store gallery images (positions 1–4 → images array)
          const galleryUrls: string[] = [];
          for (let g = 1; g <= 4; g++) {
            const gFilename = imageFilenames[g];
            const gBuf = resolveImg(gFilename);
            if (gBuf) {
              const gUrl = await storeImage(product.id, toDataUri(gFilename, gBuf), g);
              galleryUrls.push(gUrl);
            }
          }
          if (galleryUrls.length > 0) {
            product = (await storage.updateProduct(product.id, { images: galleryUrls })) ?? product;
          }

          notifyDataSync("products", "create", product.id);
          created.push(product);
        } catch (e: any) {
          errors.push(`Row ${i + 1}: "${name}" failed — ${e.message}`);
        }
      }

      const totalImagesAttached = created.reduce((sum, p) => {
        return sum + (p.imageUrl ? 1 : 0) + (p.images?.length || 0);
      }, 0);
      res.json({ created: created.length, errors, products: created, imagesAttached: totalImagesAttached });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Products routes
  app.get("/api/products", async (req, res) => {
    const allProducts = await storage.getAllProducts();
    res.json(allProducts);
  });

  app.get("/api/products/admin-catalog", async (req, res) => {
    const adminProducts = await storage.getAdminProducts();
    res.json(adminProducts);
  });

  app.get("/api/stores/:storeId/products", async (req, res) => {
    const storeProducts = await storage.getProductsByStore(req.params.storeId);
    res.json(storeProducts);
  });

  app.post("/api/products", isAuthenticated, isAdmin, async (req, res) => {
    let product: any = null;
    try {
      const store = await storage.getStore(req.body.storeId);
      if (!store) return res.status(404).json({ message: "Store not found" });
      const { cleaned, base64ImageUrl, base64Images } = stripBase64({ ...req.body, isAdminProduct: true });
      const parsed = insertProductSchema.safeParse(cleaned);
      if (!parsed.success) return res.status(400).json({ message: "Invalid data", errors: parsed.error.errors });
      product = await storage.createProduct(parsed.data);
      const imgUpdates = await applyPendingImages(product.id, base64ImageUrl, base64Images);
      if (Object.keys(imgUpdates).length > 0) product = (await storage.updateProduct(product.id, imgUpdates)) ?? product;
      notifyDataSync("products", "create", product.id);
      res.json(product);
    } catch (err: any) {
      if (product?.id) {
        try { await storage.deleteProduct(product.id); } catch (_) {}
      }
      res.status(500).json({ message: err.message || "Failed to save product. Please try again." });
    }
  });

  app.patch("/api/products/:id", isAuthenticated, isNotFrozen, async (req, res) => {
    const product = await storage.getProduct(req.params.id);
    if (!product) return res.status(404).json({ message: "Product not found" });
    const store = await storage.getStore(product.storeId);
    const userRole = (req.user as any).role;
    const isAdminUser = userRole === "admin" || userRole === "superadmin";
    if (!store || (store.ownerId !== (req.user as any).id && !isAdminUser)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const allowedFields = ["name", "details", "description", "detailedDescription", "category", "imageUrl", "images", "imageWidth", "imageHeight", "stock", "isActive", "sortOrder"];
    if (isAdminUser) {
      // Admins can always modify prices and rating
      allowedFields.push("price", "costPrice", "rating");
    } else if (!product.adminProductId) {
      // Store owners can set prices only on their own custom-uploaded products (not from admin catalog)
      allowedFields.push("price", "costPrice");
    }
    // If product came from admin catalog (adminProductId is set), store owners cannot change its price
    let updateData: any = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updateData[field] = req.body[field];
    }
    updateData = await processProductImages(product.id, updateData);
    if (updateData.rating !== undefined) {
      const r = parseFloat(updateData.rating);
      if (isNaN(r) || r < 0 || r > 5) return res.status(400).json({ message: "Rating must be between 0.0 and 5.0" });
      updateData.rating = r.toFixed(1);
    }
    const updated = await storage.updateProduct(req.params.id, updateData);
    notifyDataSync("products", "update", req.params.id);
    res.json(updated);
  });

  app.delete("/api/products/:id", isAuthenticated, async (req, res) => {
    const product = await storage.getProduct(req.params.id);
    if (!product) return res.status(404).json({ message: "Product not found" });
    const userRole = (req.user as any).role;
    const isAdminUser = userRole === "admin" || userRole === "superadmin";
    const store = await storage.getStore(product.storeId);
    if (!store || (store.ownerId !== (req.user as any).id && !isAdminUser)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const directOrders = await storage.getOrdersByProduct(req.params.id);
    if (directOrders.length > 0) {
      return res.status(409).json({
        message: `This product has ${directOrders.length} existing order(s) and cannot be deleted. Set it to inactive or reduce stock to 0 instead.`,
      });
    }
    await storage.deleteProductWithChildren(req.params.id);
    notifyDataSync("products", "delete", req.params.id);
    scheduleImageBackup(10); // images were cascade-deleted — update the image backup
    res.json({ message: "Product deleted" });
  });

  // Orders routes
  app.get("/api/orders/my", isAuthenticated, async (req, res) => {
    const userId = (req.user as any).id;
    const myOrders = await storage.getOrdersByBuyer(userId);
    res.json(myOrders);
  });

  app.get("/api/orders", isAuthenticated, isAdmin, async (req, res) => {
    const allOrders = await storage.getAllOrders();
    const linkedIds = await getLinkedUserIds(req);
    if (linkedIds === null) {
      res.json(allOrders);
    } else {
      res.json(allOrders.filter(o => linkedIds.includes(o.buyerId)));
    }
  });

  app.post("/api/orders", isAuthenticated, isNotFrozen, async (req, res) => {
    try {
      const product = await storage.getProduct(req.body.productId);
      if (!product) return res.status(404).json({ message: "Product not found" });
      if (product.stock < (req.body.quantity || 1)) return res.status(400).json({ message: "Insufficient stock" });

      const totalPrice = (parseFloat(product.price) * (req.body.quantity || 1)).toFixed(2);

      const buyer = await storage.getUser((req.user as any).id);
      if (!buyer) return res.status(404).json({ message: "User not found" });
      const userBalance = parseFloat(buyer.balance || "0");
      if (userBalance < parseFloat(totalPrice)) {
        return res.status(400).json({ message: "Insufficient balance. Please recharge your account before purchasing." });
      }

      const parsed = insertOrderSchema.safeParse({
        ...req.body,
        buyerId: (req.user as any).id,
        storeId: product.storeId,
        totalPrice,
      });
      if (!parsed.success) return res.status(400).json({ message: "Invalid data", errors: parsed.error.errors });

      const order = await storage.createOrder(parsed.data);
      await storage.updateProduct(product.id, { stock: product.stock - (req.body.quantity || 1) });

      const newBalance = (userBalance - parseFloat(totalPrice)).toFixed(2);
      await storage.updateUser(buyer.id, {
        balance: newBalance,
      } as any);
      await storage.createRechargeRecord({
        userId: buyer.id,
        amount: (-parseFloat(totalPrice)).toFixed(2),
        previousBalance: userBalance.toFixed(2),
        newBalance,
        rechargedBy: buyer.id,
        note: "Product purchase",
      });

      const userTargets = await storage.getTargetsByUser((req.user as any).id);
      for (const target of userTargets) {
        if (target.status === "active") {
          const newAmount = parseFloat(target.currentAmount) + parseFloat(totalPrice);
          const targetAmountNum = parseFloat(target.targetAmount);
          await storage.updateTarget(target.id, {
            currentAmount: newAmount.toFixed(2) as any,
            status: newAmount >= targetAmountNum ? "completed" : "active",
          });
        }
      }

      if (req.body.buyForStore) {
        if (!req.body.storeId) {
          return res.status(400).json({ message: "Store ID is required for buy-for-store" });
        }
        const targetStore = await storage.getStore(req.body.storeId);
        if (!targetStore) {
          return res.status(404).json({ message: "Target store not found" });
        }
        if (targetStore.ownerId !== (req.user as any).id) {
          return res.status(403).json({ message: "You can only stock products in your own store" });
        }
        {
          // Always use admin's product price — store owners cannot set custom prices
          const adminPrice = product.price;
          const existingProducts = await storage.getProductsByStore(req.body.storeId);
          const existingResell = existingProducts.find(
            (ep: any) => ep.adminProductId === product.id || ep.name === product.name
          );
          if (existingResell) {
            await storage.updateProduct(existingResell.id, {
              stock: existingResell.stock + (req.body.quantity || 1),
              price: adminPrice,
            });
          } else {
            await storage.createProduct({
              name: product.name,
              description: product.description,
              price: adminPrice,
              costPrice: adminPrice,
              stock: req.body.quantity || 1,
              category: product.category,
              imageUrl: product.imageUrl,
              storeId: req.body.storeId,
              isAdminProduct: false,
              adminProductId: product.id,
            } as any);
          }
        }
      }

      notifyDataSync("orders", "create", order.id);
      res.json(order);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/orders/admin", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const items = req.body.items as Array<{ productId: string; quantity: number; sellingPrice: number }>;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "At least one item is required" });
      }

      const targetStore = await storage.getStore(req.body.targetStoreId);
      if (!targetStore) return res.status(404).json({ message: "Target store not found" });

      if (req.body.isTransfer && !req.body.sourceStoreId) {
        return res.status(400).json({ message: "Source store is required for transfers" });
      }
      if (req.body.isTransfer) {
        const sourceStore = await storage.getStore(req.body.sourceStoreId);
        if (!sourceStore) return res.status(404).json({ message: "Source store not found" });
      }

      const deliverToUser = req.body.deliverToUserId ? await storage.getUser(req.body.deliverToUserId) : null;
      if (req.body.deliverToUserId && !deliverToUser) return res.status(404).json({ message: "Delivery user not found" });

      const validatedItems = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item.productId) return res.status(400).json({ message: `Item ${i + 1}: Product is required` });
        if (!item.quantity || item.quantity < 1) return res.status(400).json({ message: `Item ${i + 1}: Quantity must be at least 1` });
        if (!item.sellingPrice || item.sellingPrice <= 0) return res.status(400).json({ message: `Item ${i + 1}: Selling price must be positive` });

        const product = await storage.getProduct(item.productId);
        if (!product) return res.status(400).json({ message: `Item ${i + 1}: Product not found` });
        if (product.stock < item.quantity) return res.status(400).json({ message: `Item ${i + 1}: "${product.name}" has only ${product.stock} in stock, but ${item.quantity} requested` });
        if (req.body.isTransfer && product.storeId !== req.body.sourceStoreId) {
          return res.status(400).json({ message: `Item ${i + 1}: "${product.name}" does not belong to the source store` });
        }

        validatedItems.push({ ...item, product });
      }

      const createdOrders = [];
      let totalBulkSellingPrice = 0;
      const batchId = `BULK-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

      for (const { product, ...item } of validatedItems) {
        const qty = item.quantity;
        const costPrice = parseFloat(product.costPrice || "0");
        const sellingPrice = parseFloat(String(item.sellingPrice));
        const totalCost = (costPrice * qty).toFixed(2);
        const totalPrice = (sellingPrice * qty).toFixed(2);
        const profit = ((sellingPrice - costPrice) * qty).toFixed(2);

        const order = await storage.createOrder({
          buyerId: targetStore.ownerId,
          productId: product.id,
          storeId: product.storeId,
          quantity: qty,
          totalPrice: totalCost,
          payPrice: totalPrice,
          profit,
          remark: req.body.remark || "",
          deliveryAddress: req.body.deliveryAddress || null,
          orderedBy: (req.user as any).id,
          deliverToUserId: req.body.deliverToUserId || null,
          batchId,
        });

        await storage.updateProduct(product.id, {
          stock: product.stock - qty,
          salesCount: (product.salesCount || 0) + qty,
        });

        if (req.body.isTransfer) {
          const existingTargetProducts = await storage.getProductsByStore(targetStore.id);
          const existingProduct = existingTargetProducts.find(
            (ep: any) => ep.adminProductId === product.adminProductId || ep.adminProductId === product.id || ep.name === product.name
          );
          if (existingProduct) {
            await storage.updateProduct(existingProduct.id, {
              stock: existingProduct.stock + qty,
            });
          } else {
            await storage.createProduct({
              name: product.name,
              description: product.description,
              price: String(item.sellingPrice),
              costPrice: product.costPrice || product.price,
              stock: qty,
              category: product.category,
              imageUrl: product.imageUrl,
              storeId: targetStore.id,
              isAdminProduct: false,
              adminProductId: product.adminProductId || product.id,
            } as any);
          }
        }

        totalBulkSellingPrice += parseFloat(totalPrice);
        createdOrders.push(order);
      }

      const ownerTargets = await storage.getTargetsByUser(targetStore.ownerId);
      for (const target of ownerTargets) {
        if (target.status === "active") {
          const newAmount = parseFloat(target.currentAmount) + totalBulkSellingPrice;
          const targetAmountNum = parseFloat(target.targetAmount);
          await storage.updateTarget(target.id, {
            currentAmount: newAmount.toFixed(2) as any,
            status: newAmount >= targetAmountNum ? "completed" : "active",
          });
        }
      }

      await storage.createNotice({
        storeId: targetStore.id,
        userId: targetStore.ownerId,
        type: "system",
        title: "New Order Assigned",
        content: `You have ${createdOrders.length} new order(s) assigned to your store "${targetStore.name}". Please pick up the orders and pay for the items. Contact admin via live chat for payment details.`,
      });

      res.json({ orders: createdOrders, count: createdOrders.length });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Bulk Order System ──────────────────────────────────────────────────────

  // Admin: create a bulk order for a target store
  app.post("/api/admin/bulk-orders", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const { storeId, shippingAddress, note, items } = req.body as {
        storeId: string;
        shippingAddress: string;
        note?: string;
        items: Array<{ productId: string; quantity: number; profitAmount: number }>;
      };

      if (!storeId) return res.status(400).json({ message: "Target store is required" });
      if (!shippingAddress) return res.status(400).json({ message: "Shipping address is required" });
      if (!items || !Array.isArray(items) || items.length === 0)
        return res.status(400).json({ message: "At least one item is required" });

      const targetStore = await storage.getStore(storeId);
      if (!targetStore) return res.status(404).json({ message: "Store not found" });

      // Validate each item belongs to the target store
      const validatedItems: Array<{ productId: string; productName: string; quantity: number; costPrice: number; profitAmount: number; sellingPrice: number }> = [];
      let totalCost = 0;
      let totalProfit = 0;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item.productId) return res.status(400).json({ message: `Item ${i + 1}: product is required` });
        if (!item.quantity || item.quantity < 1) return res.status(400).json({ message: `Item ${i + 1}: quantity must be at least 1` });
        if (item.profitAmount < 0) return res.status(400).json({ message: `Item ${i + 1}: profit cannot be negative` });

        const product = await storage.getProduct(item.productId);
        if (!product) return res.status(404).json({ message: `Item ${i + 1}: product not found` });
        if (product.storeId !== storeId) return res.status(400).json({ message: `Item ${i + 1}: "${product.name}" does not belong to this store` });

        const costPrice = parseFloat(product.price);
        const profitAmount = parseFloat(String(item.profitAmount || 0));
        const sellingPrice = costPrice + profitAmount;

        totalCost += costPrice * item.quantity;
        totalProfit += profitAmount * item.quantity;

        validatedItems.push({ productId: item.productId, productName: product.name, quantity: item.quantity, costPrice, profitAmount, sellingPrice });
      }

      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const bulkOrder = await storage.createBulkOrder({
        adminId: (req.user as any).id,
        storeId,
        shippingAddress,
        note: note || "",
        totalCost: totalCost.toFixed(2),
        totalProfit: totalProfit.toFixed(2),
        status: "pending",
        expiresAt,
      } as any);

      for (const vi of validatedItems) {
        await storage.createBulkOrderItem({
          bulkOrderId: bulkOrder.id,
          productId: vi.productId,
          productName: vi.productName,
          quantity: vi.quantity,
          costPrice: String(vi.costPrice),
          profitAmount: String(vi.profitAmount),
          sellingPrice: String(vi.sellingPrice),
        } as any);
      }

      // Notify store owner
      await storage.createNotice({
        storeId: targetStore.id,
        userId: targetStore.ownerId,
        type: "system",
        title: "New Bulk Order",
        content: `A new bulk order (${bulkOrder.batchSn}) has been assigned to your store "${targetStore.name}" for $${totalCost.toFixed(2)}. You have 24 hours to accept or decline. Please check your orders.`,
      });

      const items2 = await storage.getBulkOrderItems(bulkOrder.id);
      res.json({ ...bulkOrder, items: items2 });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Admin: list all bulk orders (with items)
  app.get("/api/admin/bulk-orders", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const allOrders = await storage.getAllBulkOrders();
      // Auto-expire pending orders past their expiry time
      const now = new Date();
      const withItems = await Promise.all(allOrders.map(async (bo) => {
        let order = bo;
        if (bo.status === "pending" && new Date(bo.expiresAt) < now) {
          const expired = await storage.updateBulkOrder(bo.id, { status: "expired" });
          order = expired || bo;
        }
        const items = await storage.getBulkOrderItems(bo.id);
        const store = await storage.getStore(bo.storeId);
        const admin = await storage.getUser(bo.adminId);
        return { ...order, items, storeName: store?.name, adminUsername: admin?.username };
      }));
      res.json(withItems);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Admin: update bulk order (edit profit totals, status, complete)
  app.patch("/api/admin/bulk-orders/:id", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const bo = await storage.getBulkOrder(req.params.id);
      if (!bo) return res.status(404).json({ message: "Bulk order not found" });

      const updates: any = {};
      if (req.body.totalProfit !== undefined) updates.totalProfit = String(req.body.totalProfit);
      if (req.body.totalCost !== undefined) updates.totalCost = String(req.body.totalCost);
      if (req.body.status !== undefined) updates.status = req.body.status;
      if (req.body.shippingAddress !== undefined) updates.shippingAddress = req.body.shippingAddress;
      if (req.body.note !== undefined) updates.note = req.body.note;
      if (req.body.extendHours !== undefined) {
        const h = parseFloat(req.body.extendHours);
        if (isNaN(h) || h <= 0) return res.status(400).json({ message: "extendHours must be a positive number" });
        const current = bo.expiresAt ? new Date(bo.expiresAt) : new Date();
        // If already expired, extend from now; otherwise extend from current expiry
        const base = current < new Date() ? new Date() : current;
        updates.expiresAt = new Date(base.getTime() + h * 60 * 60 * 1000);
      }

      const updated = await storage.updateBulkOrder(bo.id, updates);
      const items = await storage.getBulkOrderItems(bo.id);
      res.json({ ...updated, items });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Merchant: get bulk orders for their stores
  app.get("/api/bulk-orders/my-store", isAuthenticated, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const myStores = await storage.getStoresByOwner(userId);
      const now = new Date();
      const allBulkOrders = [];
      for (const store of myStores) {
        const orders = await storage.getBulkOrdersByStore(store.id);
        for (let bo of orders) {
          // Auto-expire pending orders past expiry
          if (bo.status === "pending" && new Date(bo.expiresAt) < now) {
            bo = (await storage.updateBulkOrder(bo.id, { status: "expired" })) || bo;
          }
          const items = await storage.getBulkOrderItems(bo.id);
          allBulkOrders.push({ ...bo, items, storeName: store.name });
        }
      }
      res.json(allBulkOrders);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Merchant: accept a bulk order (deduct balance)
  app.patch("/api/bulk-orders/:id/accept", isAuthenticated, isNotFrozen, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const bo = await storage.getBulkOrder(req.params.id);
      if (!bo) return res.status(404).json({ message: "Bulk order not found" });

      const store = await storage.getStore(bo.storeId);
      if (!store || store.ownerId !== userId) return res.status(403).json({ message: "You do not own this store" });

      if (bo.status !== "pending") return res.status(400).json({ message: `Order is already ${bo.status}` });
      if (new Date(bo.expiresAt) < new Date()) {
        await storage.updateBulkOrder(bo.id, { status: "expired" });
        return res.status(400).json({ message: "This order has expired" });
      }

      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ message: "User not found" });

      const cost = parseFloat(bo.totalCost);
      const balance = parseFloat(user.balance);
      if (balance < cost) {
        return res.status(400).json({
          message: `Insufficient balance. You need $${cost.toFixed(2)} but have $${balance.toFixed(2)}. Please contact customer service to top up your account.`,
          insufficientBalance: true,
          required: cost,
          available: balance,
        });
      }

      // Deduct balance
      const newBalance = (balance - cost).toFixed(2);
      await storage.updateUser(userId, { balance: newBalance });
      await storage.createRechargeRecord({
        userId,
        amount: (-cost).toFixed(2),
        previousBalance: balance.toFixed(2),
        newBalance,
        rechargedBy: userId,
        note: `Bulk order payment ${bo.batchSn}`,
      });

      const updated = await storage.updateBulkOrder(bo.id, { status: "accepted", acceptedAt: new Date() });
      const items = await storage.getBulkOrderItems(bo.id);
      res.json({ ...updated, items });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Merchant: decline a bulk order
  app.patch("/api/bulk-orders/:id/decline", isAuthenticated, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const bo = await storage.getBulkOrder(req.params.id);
      if (!bo) return res.status(404).json({ message: "Bulk order not found" });

      const store = await storage.getStore(bo.storeId);
      if (!store || store.ownerId !== userId) return res.status(403).json({ message: "You do not own this store" });

      if (bo.status !== "pending") return res.status(400).json({ message: `Order is already ${bo.status}` });

      const updated = await storage.updateBulkOrder(bo.id, { status: "declined" });
      const items = await storage.getBulkOrderItems(bo.id);
      res.json({ ...updated, items });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── End Bulk Order System ──────────────────────────────────────────────────

  app.post("/api/products/custom", isAuthenticated, isNotFrozen, async (req, res) => {
    let product: any = null;
    try {
      const store = await storage.getStore(req.body.storeId);
      if (!store) return res.status(404).json({ message: "Store not found" });
      if (store.ownerId !== (req.user as any).id) return res.status(403).json({ message: "Forbidden" });
      if (!store.isApproved) return res.status(403).json({ message: "Store is not approved yet" });

      const user = await storage.getUser((req.user as any).id);
      if (!user) return res.status(403).json({ message: "User not found" });

      const isAdmin = user.role === "admin" || user.role === "superadmin";
      if (!isAdmin) {
        if (!user.referredBy) return res.status(403).json({ message: "Only merchants can upload custom products" });
        const allUsers = await storage.getAllUsers();
        const referrer = allUsers.find(u => u.id === user.referredBy);
        if (!referrer || (referrer.role !== "admin" && referrer.role !== "superadmin")) {
          return res.status(403).json({ message: "Only merchants referred by an admin can upload custom products" });
        }
      }

      const { cleaned, base64ImageUrl, base64Images } = stripBase64({ ...req.body, isAdminProduct: false, adminProductId: null });
      const parsed = insertProductSchema.safeParse(cleaned);
      if (!parsed.success) return res.status(400).json({ message: "Invalid data", errors: parsed.error.errors });
      product = await storage.createProduct(parsed.data);
      const imgUpdates = await applyPendingImages(product.id, base64ImageUrl, base64Images);
      if (Object.keys(imgUpdates).length > 0) product = (await storage.updateProduct(product.id, imgUpdates)) ?? product;
      notifyDataSync("products", "create", product.id);
      res.json(product);
    } catch (err: any) {
      if (product?.id) {
        try { await storage.deleteProduct(product.id); } catch (_) {}
      }
      res.status(500).json({ message: err.message || "Failed to save product. Please try again." });
    }
  });

  app.post("/api/products/resell", isAuthenticated, isNotFrozen, async (req, res) => {
    try {
      const adminProduct = await storage.getProduct(req.body.adminProductId);
      if (!adminProduct || !adminProduct.isAdminProduct) return res.status(404).json({ message: "Admin product not found" });

      const store = await storage.getStore(req.body.storeId);
      if (!store) return res.status(404).json({ message: "Store not found" });
      if (store.ownerId !== (req.user as any).id) return res.status(403).json({ message: "Forbidden" });
      if (!store.isApproved) return res.status(403).json({ message: "Store is not approved yet. Please wait for admin approval." });

      const resellPrice = req.body.price || adminProduct.price;
      const qty = parseInt(req.body.quantity) || parseInt(req.body.stock) || 10;

      const existingProducts = await storage.getProductsByStore(store.id);
      const existing = existingProducts.find(p => p.adminProductId === adminProduct.id);

      if (existing) {
        const updated = await storage.updateProduct(existing.id, {
          stock: existing.stock + qty,
          price: resellPrice,
        });
        return res.json(updated);
      }

      const product = await storage.createProduct({
        storeId: store.id,
        name: adminProduct.name,
        description: adminProduct.description,
        price: resellPrice,
        category: adminProduct.category,
        imageUrl: adminProduct.imageUrl,
        stock: qty,
        isAdminProduct: false,
        adminProductId: adminProduct.id,
      });
      notifyDataSync("products", "create", product.id);
      res.json(product);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/orders/:id/status", isAuthenticated, isSuperAdmin, async (req, res) => {
    const order = await storage.getOrder(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });
    const updated = await storage.updateOrderStatus(req.params.id, req.body.status);
    if (!updated) return res.status(404).json({ message: "Order not found" });
    notifyDataSync("orders", "update", req.params.id);
    res.json(updated);
  });

  app.patch("/api/orders/:id/complete", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const order = await storage.getOrder(req.params.id);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.status !== "processing") return res.status(400).json({ message: "Only processing orders can be completed" });
      const linkedIds = await getLinkedUserIds(req);
      if (linkedIds !== null && !linkedIds.includes(order.buyerId)) {
        return res.status(403).json({ message: "You can only manage your linked customers' orders" });
      }
      const updated = await storage.updateOrderStatus(req.params.id, "completed");
      await storage.createNotice({
        userId: order.buyerId,
        type: "system",
        title: "Order Delivered Successfully!",
        content: `Your order #${order.orderSn} has been delivered successfully. Thank you for your business!`,
      });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/orders/:id/reject", isAuthenticated, isNotFrozen, async (req, res) => {
    try {
      const order = await storage.getOrder(req.params.id);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.buyerId !== (req.user as any).id) return res.status(403).json({ message: "Forbidden" });
      if (order.status !== "pending") return res.status(400).json({ message: "Only pending orders can be removed" });

      const product = await storage.getProduct(order.productId);
      if (product) {
        await storage.updateProduct(product.id, {
          stock: product.stock + order.quantity,
          salesCount: Math.max(0, (product.salesCount ?? 0) - order.quantity),
        });
      }

      const updated = await storage.updateOrderStatus(req.params.id, "cancelled");
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/orders/:id/pickup", isAuthenticated, isNotFrozen, async (req, res) => {
    try {
      const order = await storage.getOrder(req.params.id);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.buyerId !== (req.user as any).id) return res.status(403).json({ message: "Forbidden" });
      if (order.status !== "pending") return res.status(400).json({ message: "Order cannot be picked up" });

      const isAdminAssigned = order.orderedBy && order.orderedBy !== order.buyerId;

      if (isAdminAssigned) {
        const buyer = await storage.getUser((req.user as any).id);
        if (!buyer) return res.status(404).json({ message: "User not found" });
        const orderCost = parseFloat(order.totalPrice || "0");
        const userBalance = parseFloat(buyer.balance || "0");
        if (userBalance < orderCost) {
          return res.status(400).json({ message: `Insufficient balance. You need $${orderCost.toFixed(2)} but have $${userBalance.toFixed(2)}. Please recharge first.` });
        }
        const newBal = (userBalance - orderCost).toFixed(2);
        await storage.updateUser(buyer.id, {
          balance: newBal,
        } as any);
        await storage.createRechargeRecord({
          userId: buyer.id,
          amount: (-orderCost).toFixed(2),
          previousBalance: userBalance.toFixed(2),
          newBalance: newBal,
          rechargedBy: buyer.id,
          note: `Order pickup #${order.orderSn}`,
        });
      }

      const updated = await storage.updateOrderStatus(req.params.id, "processing");

      const product = await storage.getProduct(order.productId);
      const store = product ? await storage.getStore(product.storeId) : null;
      await storage.createNotice({
        storeId: store?.id,
        userId: order.buyerId,
        type: "info",
        title: "Order Picked Up - Buy Items",
        content: `Your order #${order.orderSn} has been picked up. Please buy the required items from the marketplace to fulfill this order. Contact admin via live chat for payment details and send proof of payment.`,
      });

      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/orders/pickup-all", isAuthenticated, isNotFrozen, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const buyer = await storage.getUser(userId);
      if (!buyer) return res.status(404).json({ message: "User not found" });

      const myOrders = await storage.getOrdersByBuyer(userId);
      const pendingOrders = myOrders.filter(o => o.status === "pending");
      const adminAssignedOrders = pendingOrders.filter(o => o.orderedBy && o.orderedBy !== o.buyerId);
      const totalCost = adminAssignedOrders.reduce((sum, o) => sum + parseFloat(o.totalPrice || "0"), 0);
      const userBalance = parseFloat(buyer.balance || "0");

      if (userBalance < totalCost) {
        return res.status(400).json({ message: `Insufficient balance. You need $${totalCost.toFixed(2)} but have $${userBalance.toFixed(2)}. Please recharge first.` });
      }

      const results = [];
      for (const order of pendingOrders) {
        const updated = await storage.updateOrderStatus(order.id, "processing");
        if (updated) results.push(updated);
      }

      if (totalCost > 0) {
        const newBulkBal = (userBalance - totalCost).toFixed(2);
        await storage.updateUser(buyer.id, {
          balance: newBulkBal,
        } as any);
        await storage.createRechargeRecord({
          userId,
          amount: (-totalCost).toFixed(2),
          previousBalance: userBalance.toFixed(2),
          newBalance: newBulkBal,
          rechargedBy: userId,
          note: `Bulk pickup of ${results.length} order(s)`,
        });
      }

      if (results.length > 0) {
        await storage.createNotice({
          userId,
          type: "info",
          title: "Orders Picked Up - Buy Items",
          content: `You have picked up ${results.length} order(s). Please buy the required items from the marketplace to fulfill your orders. Contact admin via live chat for payment details and send proof of payment.`,
        });
      }

      res.json({ updated: results.length });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Targets routes
  app.get("/api/targets/my", isAuthenticated, async (req, res) => {
    const userId = (req.user as any).id;
    const myTargets = await storage.getTargetsByUser(userId);
    res.json(myTargets);
  });

  app.get("/api/targets", isAuthenticated, isAdmin, async (req, res) => {
    const allTargets = await storage.getAllTargets();
    const linkedIds = await getLinkedUserIds(req);
    if (linkedIds === null) {
      res.json(allTargets);
    } else {
      res.json(allTargets.filter(t => linkedIds.includes(t.userId)));
    }
  });

  app.post("/api/targets", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const parsed = insertTargetSchema.safeParse({
        ...req.body,
        assignedBy: (req.user as any).id,
        deadline: req.body.deadline ? new Date(req.body.deadline) : undefined,
      });
      if (!parsed.success) return res.status(400).json({ message: "Invalid data", errors: parsed.error.errors });
      const target = await storage.createTarget(parsed.data);

      // Notify via WebSocket
      const targetUser = clients.get(parsed.data.userId);
      if (targetUser && targetUser.readyState === WebSocket.OPEN) {
        targetUser.send(JSON.stringify({ type: "target_assigned", target }));
      }

      res.json(target);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/targets/:id", isAuthenticated, isAdmin, async (req, res) => {
    const updated = await storage.updateTarget(req.params.id, req.body);
    if (!updated) return res.status(404).json({ message: "Target not found" });
    res.json(updated);
  });

  // Chat routes
  app.get("/api/chat/messages", isAuthenticated, async (req, res) => {
    const userId = (req.user as any).id;
    const role = (req.user as any).role;
    if (role === "admin") {
      return res.status(403).json({ message: "Only super admin can access chat" });
    }
    if (role === "superadmin") {
      const allMessages = await storage.getAllChatMessages();
      res.json(allMessages);
    } else {
      const messages = await storage.getChatMessages(userId);
      res.json(messages);
    }
  });

  app.get("/api/chat/unread", isAuthenticated, async (req, res) => {
    const role = (req.user as any).role;
    if (role === "admin") {
      return res.status(403).json({ message: "Only super admin can access chat" });
    }
    const count = await storage.getUnreadCount((req.user as any).id);
    res.json({ count });
  });

  app.post("/api/chat/messages", isAuthenticated, async (req, res) => {
    try {
      const senderRole = (req.user as any).role;
      if (senderRole === "admin") {
        return res.status(403).json({ message: "Only super admin can send chat messages" });
      }

      const message = await storage.createChatMessage({
        senderId: (req.user as any).id,
        receiverId: req.body.receiverId || null,
        content: req.body.content || "",
        imageUrl: req.body.imageUrl || null,
      });

      const targetId = req.body.receiverId;
      if (targetId) {
        const targetWs = clients.get(targetId);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({ type: "chat_message", message }));
        }
      }

      if (senderRole === "client") {
        const allUsers = await storage.getAllUsers();
        const superAdmin = allUsers.find(u => u.role === "superadmin");
        if (superAdmin) {
          const adminWs = clients.get(superAdmin.id);
          if (adminWs && adminWs.readyState === WebSocket.OPEN) {
            adminWs.send(JSON.stringify({ type: "chat_message", message, senderRole: "client" }));
          }
        }
      }

      res.json(message);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/chat/read", isAuthenticated, async (req, res) => {
    const role = (req.user as any).role;
    if (role === "admin") {
      return res.status(403).json({ message: "Only super admin can access chat" });
    }
    const isAdmin = role === "superadmin";
    await storage.markMessagesRead((req.user as any).id, req.body.senderId, isAdmin);
    res.json({ message: "Marked as read" });
  });

  app.get("/api/chat/pinned", isAuthenticated, async (req, res) => {
    const role = (req.user as any).role;
    if (role === "admin") return res.status(403).json({ message: "Forbidden" });
    const msg = await storage.getPinnedChatMessage();
    res.json(msg ?? null);
  });

  app.post("/api/chat/pin/:id", isAuthenticated, async (req, res) => {
    const role = (req.user as any).role;
    if (role !== "superadmin") return res.status(403).json({ message: "Only admin can pin messages" });
    const msg = await storage.pinChatMessage(req.params.id);
    res.json(msg ?? null);
  });

  app.post("/api/chat/unpin", isAuthenticated, async (req, res) => {
    const role = (req.user as any).role;
    if (role !== "superadmin") return res.status(403).json({ message: "Only admin can unpin messages" });
    await storage.unpinAllChatMessages();
    res.json({ message: "Unpinned" });
  });

  app.patch("/api/users/:id", isAuthenticated, isAdmin, async (req, res) => {
    const linkedIds = await getLinkedUserIds(req);
    if (linkedIds !== null && !linkedIds.includes(req.params.id)) {
      return res.status(403).json({ message: "You can only manage your own linked customers" });
    }
    const user = await storage.getUser(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    const allowedFields = ["balance", "grade", "credit", "goodRate", "phone", "vipLevel", "rating"];
    const updateData: any = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updateData[field] = req.body[field];
    }
    if (updateData.balance !== undefined) {
      const previousBalance = user.balance;
      const newBalance = updateData.balance;
      const amount = (parseFloat(newBalance) - parseFloat(previousBalance as string)).toFixed(2);
      await storage.createRechargeRecord({
        userId: req.params.id,
        amount,
        previousBalance: previousBalance as string,
        newBalance,
        rechargedBy: (req.user as any).id,
        note: req.body.rechargeNote || "Balance update by admin",
      });
    }
    const updated = await storage.updateUser(req.params.id, updateData);
    if (!updated) return res.status(404).json({ message: "User not found" });
    notifyDataSync("users", "update", req.params.id);
    const { password, ...safeUser } = updated;
    res.json(safeUser);
  });

  app.patch("/api/users/:id/password", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const linkedIds = await getLinkedUserIds(req);
      if (linkedIds !== null && !linkedIds.includes(req.params.id)) {
        return res.status(403).json({ message: "You can only manage your own linked customers" });
      }
      const user = await storage.getUser(req.params.id);
      if (!user) return res.status(404).json({ message: "User not found" });
      const { newPassword } = req.body;
      if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters" });
      }
      const updated = await storage.updateUser(req.params.id, { password: hashPassword(newPassword) } as any);
      if (!updated) return res.status(404).json({ message: "User not found" });
      res.json({ message: "Password updated successfully" });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Super Admin: admin management
  app.get("/api/admins", isAuthenticated, isSuperAdmin, async (req, res) => {
    const allUsers = await storage.getAllUsers();
    const admins = allUsers.filter(u => u.role === "admin");
    const result = admins.map(admin => {
      const { password, ...safeAdmin } = admin;
      const customerCount = allUsers.filter(u => u.referredBy === admin.id).length;
      return { ...safeAdmin, customerCount };
    });
    res.json(result);
  });

  app.post("/api/admins", isAuthenticated, isSuperAdmin, async (req, res) => {
    try {
      const { email, username, password: pw, age, profession, phone } = req.body;
      if (!email || !username || !pw) return res.status(400).json({ message: "Email, username and password are required" });
      const existing = await storage.getUserByEmail(email);
      if (existing) return res.status(400).json({ message: "Email already in use" });
      const refCode = generateReferenceCode();
      const admin = await storage.createUser({ email, username, password: hashPassword(pw), age: age || 25, profession: profession || "Admin", phone: phone || "" } as any);
      const updated = await storage.updateUser(admin.id, { role: "admin", referenceCode: refCode } as any);
      if (!updated) return res.status(500).json({ message: "Failed to create admin" });
      const { password: p, ...safeAdmin } = updated;
      res.json(safeAdmin);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/admins/:id", isAuthenticated, isSuperAdmin, async (req, res) => {
    const user = await storage.getUser(req.params.id);
    if (!user) return res.status(404).json({ message: "Admin not found" });
    if (user.role === "superadmin") return res.status(400).json({ message: "Cannot remove super admin" });
    await storage.updateUser(req.params.id, { role: "client", referenceCode: null } as any);
    res.json({ message: "Admin removed" });
  });

  app.post("/api/superadmins", isAuthenticated, isSuperAdmin, async (req, res) => {
    try {
      const { email, username, password: pw, phone } = req.body;
      if (!email || !username || !pw) return res.status(400).json({ message: "Email, username and password are required" });
      const existing = await storage.getUserByEmail(email);
      if (existing) return res.status(400).json({ message: "Email already in use" });
      const user = await storage.createUser({ email, username, password: hashPassword(pw), age: 25, profession: "Admin", phone: phone || "" } as any);
      const updated = await storage.updateUser(user.id, { role: "superadmin" } as any);
      if (!updated) return res.status(500).json({ message: "Failed to create superadmin" });
      const { password: p, ...safe } = updated;
      res.json(safe);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/admin/change-password", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      const adminId = (req.user as any).id;
      const user = await storage.getUser(adminId);
      if (!user) return res.status(404).json({ message: "User not found" });
      if (user.password !== hashPassword(currentPassword)) {
        return res.status(400).json({ message: "Current password is incorrect" });
      }
      if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ message: "New password must be at least 6 characters" });
      }
      await storage.updateUser(adminId, { password: hashPassword(newPassword) } as any);
      res.json({ message: "Password changed successfully" });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/admins/:id/customers", isAuthenticated, isSuperAdmin, async (req, res) => {
    const allUsers = await storage.getAllUsers();
    const customers = allUsers.filter(u => u.referredBy === req.params.id);
    res.json(customers.map(({ password, ...u }) => u));
  });

  app.get("/api/users/:id/daily-stats", isAuthenticated, async (req, res) => {
    const requestingUser = req.user as any;
    const targetId = req.params.id;
    if (requestingUser.id !== targetId && requestingUser.role === "client") {
      return res.status(403).json({ message: "Forbidden" });
    }
    const stats = await storage.getDailyStatsByUser(targetId);
    res.json(stats);
  });

  app.post("/api/users/:id/daily-stats", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const { date, purchases, sales, profit } = req.body;
      if (!date) return res.status(400).json({ message: "Date is required" });
      const stat = await storage.upsertDailyStat(req.params.id, date, {
        purchases: purchases ?? "0",
        sales: sales ?? "0",
        profit: profit ?? "0",
        setBy: (req.user as any).id,
      });
      res.json(stat);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/merchants/:id", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const merchantId = req.params.id;
      const merchant = await storage.getUser(merchantId);
      if (!merchant) return res.status(404).json({ message: "Merchant not found" });
      if (merchant.role === "admin" || merchant.role === "superadmin") {
        return res.status(400).json({ message: "Cannot remove admin users via this endpoint" });
      }
      const linkedIds = await getLinkedUserIds(req);
      if (linkedIds !== null && !linkedIds.includes(merchantId)) {
        return res.status(403).json({ message: "You can only remove your own linked merchants" });
      }
      await storage.updateUser(merchantId, { referredBy: null, isFrozen: true } as any);
      res.json({ message: "Merchant removed from platform" });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Admin: create merchant
  app.post("/api/merchants", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const { email, username, password: pw, phone, age, profession } = req.body;
      if (!email || !username || !pw) return res.status(400).json({ message: "Email, username and password are required" });
      const existing = await storage.getUserByEmail(email);
      if (existing) return res.status(400).json({ message: "Email already in use" });
      const allUsers = await storage.getAllUsers();
      if (allUsers.find(u => u.username === username)) return res.status(400).json({ message: "Username already in use" });
      const merchant = await storage.createUser({
        email, username, password: hashPassword(pw),
        age: age || 25, profession: profession || "Merchant", phone: phone || "",
      } as any);
      const updated = await storage.updateUser(merchant.id, { referredBy: (req.user as any).id } as any);
      if (!updated) return res.status(500).json({ message: "Failed to create merchant" });
      const { password: p, ...safeMerchant } = updated;
      res.json(safeMerchant);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Admin: stock products into a merchant's store
  app.post("/api/stores/:id/stock", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const store = await storage.getStore(req.params.id);
      if (!store) return res.status(404).json({ message: "Store not found" });
      const linkedIds = await getLinkedUserIds(req);
      if (linkedIds !== null && !linkedIds.includes(store.ownerId)) {
        return res.status(403).json({ message: "You can only manage your own linked customers' stores" });
      }
      const { productId, quantity, resellPrice } = req.body;
      const qty = parseInt(quantity) || 1;
      const price = parseFloat(resellPrice);
      if (qty <= 0) return res.status(400).json({ message: "Quantity must be positive" });
      if (resellPrice && (isNaN(price) || price <= 0)) return res.status(400).json({ message: "Price must be positive" });
      const adminProduct = await storage.getProduct(productId);
      if (!adminProduct) return res.status(404).json({ message: "Product not found" });
      if (!adminProduct.isAdminProduct) return res.status(400).json({ message: "Can only stock from admin catalog" });
      if (adminProduct.stock < qty) return res.status(400).json({ message: "Insufficient admin stock" });
      const existingProducts = await storage.getProductsByStore(store.id);
      const existing = existingProducts.find(p => p.adminProductId === adminProduct.id);
      if (existing) {
        const updated = await storage.updateProduct(existing.id, {
          stock: existing.stock + qty,
          price: resellPrice ? price.toFixed(2) : existing.price,
        } as any);
        await storage.updateProduct(adminProduct.id, { stock: adminProduct.stock - qty } as any);
        res.json(updated);
      } else {
        const maxSort = existingProducts.reduce((max, p) => Math.max(max, p.sortOrder || 0), 0);
        const product = await storage.createProduct({
          storeId: store.id,
          name: adminProduct.name,
          description: adminProduct.description,
          price: resellPrice ? price.toFixed(2) : adminProduct.price,
          costPrice: adminProduct.price,
          category: adminProduct.category,
          imageUrl: adminProduct.imageUrl,
          stock: qty,
          isAdminProduct: false,
          adminProductId: adminProduct.id,
          sortOrder: maxSort + 1,
        } as any);
        await storage.updateProduct(adminProduct.id, { stock: adminProduct.stock - qty } as any);
        res.json(product);
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Customer: reorder products in their store
  app.patch("/api/products/reorder", isAuthenticated, async (req, res) => {
    try {
      const { productIds } = req.body;
      if (!Array.isArray(productIds)) return res.status(400).json({ message: "productIds must be an array" });
      for (let i = 0; i < productIds.length; i++) {
        const product = await storage.getProduct(productIds[i]);
        if (!product) continue;
        const store = await storage.getStore(product.storeId);
        if (!store || store.ownerId !== (req.user as any).id) continue;
        await storage.updateProduct(productIds[i], { sortOrder: i } as any);
      }
      res.json({ message: "Products reordered" });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Admin: get customer activity summary
  app.get("/api/users/:id/activity", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const linkedIds = await getLinkedUserIds(req);
      if (linkedIds !== null && !linkedIds.includes(req.params.id)) {
        return res.status(403).json({ message: "Access denied" });
      }
      const user = await storage.getUser(req.params.id);
      if (!user) return res.status(404).json({ message: "User not found" });
      const allOrders = await storage.getAllOrders();
      const userOrders = allOrders.filter(o => o.userId === req.params.id || o.buyerId === req.params.id);
      const allWithdrawals = await storage.getAllWithdrawals();
      const userWithdrawals = allWithdrawals.filter(w => w.userId === req.params.id);
      const allStores = await storage.getAllStores();
      const userStores = allStores.filter(s => s.ownerId === req.params.id);
      const allTargets = await storage.getAllTargets();
      const userTargets = allTargets.filter(t => t.userId === req.params.id);
      const { password, ...safeUser } = user;
      res.json({
        user: safeUser,
        orders: { total: userOrders.length, pending: userOrders.filter(o => o.status === "pending").length, completed: userOrders.filter(o => o.status === "completed").length },
        withdrawals: { total: userWithdrawals.length, pending: userWithdrawals.filter(w => w.status === "pending").length, approved: userWithdrawals.filter(w => w.status === "approved").length },
        stores: { total: userStores.length, approved: userStores.filter(s => s.isApproved).length, pending: userStores.filter(s => !s.isApproved).length },
        targets: { total: userTargets.length, active: userTargets.filter(t => t.status === "active").length, completed: userTargets.filter(t => t.status === "completed").length },
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Admin: update store notes
  app.patch("/api/stores/:id/notes", isAuthenticated, isAdmin, async (req, res) => {
    const store = await storage.getStore(req.params.id);
    if (!store) return res.status(404).json({ message: "Store not found" });
    const updated = await storage.updateStore(req.params.id, { adminNotes: req.body.adminNotes } as any);
    res.json(updated);
  });

  app.get("/api/admin/backup-info", isAuthenticated, isSuperAdmin, (req, res) => {
    try {
      const backupFile = path.join(process.cwd(), "backups", "latest_backup.json");
      if (!fs.existsSync(backupFile)) return res.json({ exists: false });
      const stat = fs.statSync(backupFile);
      const raw = fs.readFileSync(backupFile, "utf-8");
      const data = JSON.parse(raw);
      res.json({
        exists: true,
        timestamp: data.timestamp,
        version: data.version || 1,
        fileSize: stat.size,
        hasImages: (data.productImages?.length || 0) > 0,
        counts: {
          users: data.users?.length || 0,
          stores: data.stores?.length || 0,
          products: data.products?.length || 0,
          productImages: data.productImages?.length || 0,
          orders: data.orders?.length || 0,
          targets: data.targets?.length || 0,
          chatMessages: data.chatMessages?.length || 0,
          withdrawals: data.withdrawals?.length || 0,
          merchantNotices: data.merchantNotices?.length || 0,
          rechargeHistory: data.rechargeHistory?.length || 0,
          userDailyStats: data.userDailyStats?.length || 0,
        },
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ── Supabase cloud backup endpoints ──────────────────────────────────────────

  // Info about the two Supabase cloud backups (current + previous)
  app.get("/api/admin/supabase-backup/info", isAuthenticated, isSuperAdmin, async (req, res) => {
    try {
      const rows = await db.select().from(backups);
      const result = rows.map(r => {
        let counts: any = {};
        try {
          const d = JSON.parse(r.data);
          if (r.label === "images") {
            counts = { productImages: d.productImages?.length || 0 };
          } else {
            counts = {
              users: d.users?.length || 0,
              stores: d.stores?.length || 0,
              products: d.products?.length || 0,
              orders: d.orders?.length || 0,
              withdrawals: d.withdrawals?.length || 0,
            };
          }
        } catch {}
        return { label: r.label, createdAt: r.createdAt, byteSize: Buffer.byteLength(r.data, "utf-8"), counts };
      });
      // Sort: current, previous, images
      const order = ["current", "previous", "images"];
      result.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
      res.json({ backups: result });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Trigger Supabase cloud backups immediately (metadata + images)
  app.post("/api/admin/supabase-backup/trigger", isAuthenticated, isSuperAdmin, async (req, res) => {
    try {
      scheduleBackup(0);
      scheduleImageBackup(2); // image backup runs 2 s after metadata backup
      res.json({ message: "Supabase backup scheduled (metadata + images)" });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Download a specific Supabase cloud backup (label = 'current', 'previous', or 'images')
  app.get("/api/admin/supabase-backup/download/:label", isAuthenticated, isSuperAdmin, async (req, res) => {
    try {
      const label = req.params.label;
      if (!["current", "previous", "images"].includes(label)) return res.status(400).json({ message: "label must be 'current', 'previous', or 'images'" });
      const rows = await db.select().from(backups).where(eq(backups.label, label));
      if (!rows.length) return res.status(404).json({ message: `No ${label} Supabase backup found` });
      const row = rows[0];
      const dateStr = new Date(row.createdAt).toISOString().slice(0, 10);
      const zip = new AdmZip();
      zip.addFile("backup.json", Buffer.from(row.data, "utf-8"));
      zip.addFile("README.txt", Buffer.from(`MarketNest Supabase Cloud Backup (${label})\nDate: ${new Date(row.createdAt).toUTCString()}\nTo restore: upload this ZIP via Admin Panel → Backup → Restore from Backup File.\n`, "utf-8"));
      const zipBuffer = zip.toBuffer();
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="marketnest_supabase_${label}_${dateStr}.zip"`);
      res.end(zipBuffer);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────

  // Metadata backup download — returns a ZIP containing backup.json.
  // Images are backed up separately in the Supabase 'images' slot.
  app.get("/api/admin/backup/download", isAuthenticated, isSuperAdmin, async (req, res) => {
    try {
      const [allUsers, allStores, allProducts, allOrders, allTargets, allMessages, allWithdrawals, allNotices, allRecharge, allDailyStats] = await Promise.all([
        db.select().from(users),
        db.select().from(stores),
        db.select().from(products),
        db.select().from(orders),
        db.select().from(targets),
        db.select().from(chatMessages),
        db.select().from(withdrawals),
        db.select().from(merchantNotices),
        db.select().from(rechargeHistory),
        db.select().from(userDailyStats),
      ]);

      const backupData = {
        timestamp: new Date().toISOString(),
        version: 3,
        note: "Images are stored separately in the Supabase images backup slot. Download it from the Backup tab.",
        users: allUsers,
        stores: allStores,
        products: allProducts,
        orders: allOrders,
        targets: allTargets,
        chatMessages: allMessages,
        withdrawals: allWithdrawals,
        merchantNotices: allNotices,
        rechargeHistory: allRecharge,
        userDailyStats: allDailyStats,
      };

      const jsonStr = JSON.stringify(backupData);

      // Persist it as the latest backup for auto-restore on new deployments
      const backupDir = path.join(process.cwd(), "backups");
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, "latest_backup.json"), jsonStr);

      const dateStr = new Date().toISOString().slice(0, 10);
      const readme = `MarketNest Data Backup\n======================\nDate: ${new Date().toUTCString()}\nUsers: ${allUsers.length} | Stores: ${allStores.length} | Products: ${allProducts.length} | Orders: ${allOrders.length}\n\nNote: Product images are stored separately in the Supabase images backup slot.\nTo restore: upload this ZIP via Admin Panel → Backup → Restore from Backup File.\n`;

      const zip = new AdmZip();
      zip.addFile("backup.json", Buffer.from(jsonStr, "utf-8"));
      zip.addFile("README.txt", Buffer.from(readme, "utf-8"));
      const zipBuffer = zip.toBuffer();

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="marketnest_backup_${dateStr}.zip"`);
      res.end(zipBuffer);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Restore from uploaded JSON or ZIP backup file
  const uploadJson = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ok = file.mimetype === "application/json" || file.originalname.endsWith(".json")
              || file.mimetype === "application/zip" || file.originalname.endsWith(".zip");
      cb(null, ok);
    },
  });

  app.post("/api/admin/backup/restore-file", isAuthenticated, isSuperAdmin, uploadJson.single("backup"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No backup file provided" });

      let raw: string;
      if (req.file.originalname.endsWith(".zip") || req.file.mimetype === "application/zip") {
        // Extract backup.json from inside the ZIP
        const zip = new AdmZip(req.file.buffer);
        const entry = zip.getEntry("backup.json");
        if (!entry) return res.status(400).json({ message: "ZIP does not contain backup.json" });
        raw = entry.getData().toString("utf-8");
      } else {
        raw = req.file.buffer.toString("utf-8");
      }

      const data = JSON.parse(raw);
      if (!data.timestamp || !data.version) {
        return res.status(400).json({ message: "Invalid backup file format" });
      }

      // Save as latest backup first so auto-restore can use it in future
      const backupDir = path.join(process.cwd(), "backups");
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const backupFile = path.join(backupDir, "latest_backup.json");
      fs.writeFileSync(backupFile, raw);

      const result = await restoreFromBackup(backupFile);
      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/admin/restore-backup", isAuthenticated, isSuperAdmin, async (req, res) => {
    try {
      const backupFile = path.join(process.cwd(), "backups", "latest_backup.json");
      const result = await restoreFromBackup(backupFile);
      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/admin/recharge-history", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const allRecords = await storage.getAllRechargeHistory();
      const linkedIds = await getLinkedUserIds(req);
      if (linkedIds === null) {
        res.json(allRecords);
      } else {
        res.json(allRecords.filter(r => linkedIds.includes(r.userId)));
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/admin/records/notices", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const allNotices = await storage.getAllNotices();
      const linkedIds = await getLinkedUserIds(req);
      if (linkedIds === null) {
        res.json(allNotices);
      } else {
        res.json(allNotices.filter(n => n.userId && linkedIds.includes(n.userId)));
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/admin/bulk-records", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const allOrders = await storage.getAllOrders();
      const bulkOrders = allOrders.filter(o => o.orderedBy && o.orderedBy !== o.buyerId);
      const linkedIds = await getLinkedUserIds(req);
      if (linkedIds === null) {
        res.json(bulkOrders);
      } else {
        res.json(bulkOrders.filter(o => linkedIds.includes(o.buyerId)));
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/stores/:id/approve", isAuthenticated, isAdmin, async (req, res) => {
    const store = await storage.getStore(req.params.id);
    if (!store) return res.status(404).json({ message: "Store not found" });
    const linkedIds = await getLinkedUserIds(req);
    if (linkedIds !== null && !linkedIds.includes(store.ownerId)) {
      return res.status(403).json({ message: "You can only manage your own linked customers' stores" });
    }
    const updated = await storage.updateStore(req.params.id, { isApproved: true } as any);
    await storage.createNotice({
      storeId: store.id,
      userId: store.ownerId,
      type: "system",
      title: "Congratulations! Store Approved 🎉",
      content: "Congratulations! Your store has been approved by the admin. You can now start adding products and selling on MarketNest. Welcome aboard!",
    });
    notifyDataSync("stores", "update", req.params.id);
    res.json(updated);
  });

  app.patch("/api/stores/:id/reject", isAuthenticated, isAdmin, async (req, res) => {
    const store = await storage.getStore(req.params.id);
    if (!store) return res.status(404).json({ message: "Store not found" });
    const linkedIds = await getLinkedUserIds(req);
    if (linkedIds !== null && !linkedIds.includes(store.ownerId)) {
      return res.status(403).json({ message: "You can only manage your own linked customers' stores" });
    }
    await storage.deleteStore(req.params.id);
    await storage.createNotice({
      userId: store.ownerId,
      type: "warning",
      title: "Store Rejected",
      content: "Your store registration has been rejected by the admin.",
    });
    res.json({ message: "Store rejected and deleted" });
  });

  app.post("/api/auth/forgot-password", async (req, res) => {
    try {
      const { email, phone, nicImageUrl } = req.body;
      if (!email || !phone || !nicImageUrl) {
        return res.status(400).json({ message: "Email, phone number, and NIC image are required" });
      }
      const user = await storage.getUserByEmail(email);
      if (!user) return res.status(404).json({ message: "No account found with this email" });
      if (user.phone !== phone) return res.status(400).json({ message: "Phone number does not match the account" });
      const request = await storage.createPasswordResetRequest({ userId: user.id, email, phone, nicImageUrl });
      res.json({ message: "Password reset request submitted. Please wait for admin approval." });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/password-resets", isAuthenticated, isAdmin, async (req, res) => {
    const all = await storage.getAllPasswordResetRequests();
    res.json(all);
  });

  app.patch("/api/password-resets/:id/approve", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const requests = await storage.getAllPasswordResetRequests();
      const request = requests.find(r => r.id === req.params.id);
      if (!request) return res.status(404).json({ message: "Request not found" });
      if (request.status !== "pending") return res.status(400).json({ message: "Request already processed" });
      await storage.updateUser(request.userId, { password: hashPassword("123456") });
      await storage.updatePasswordResetRequestStatus(req.params.id, "approved");
      await storage.createNotice({
        userId: request.userId,
        type: "system",
        title: "Password Reset Approved",
        content: "Your password has been reset to 123456. Please login and change your password from your profile.",
      });
      res.json({ message: "Password reset approved" });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/password-resets/:id/reject", isAuthenticated, isAdmin, async (req, res) => {
    try {
      await storage.updatePasswordResetRequestStatus(req.params.id, "rejected");
      res.json({ message: "Password reset rejected" });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Withdrawals routes
  app.get("/api/withdrawals", isAuthenticated, isAdmin, async (req, res) => {
    const all = await storage.getAllWithdrawals();
    const linkedIds = await getLinkedUserIds(req);
    if (linkedIds === null) {
      res.json(all);
    } else {
      res.json(all.filter(w => linkedIds.includes(w.userId)));
    }
  });

  app.get("/api/withdrawals/my", isAuthenticated, async (req, res) => {
    const userId = (req.user as any).id;
    const myWithdrawals = await storage.getWithdrawalsByUser(userId);
    res.json(myWithdrawals);
  });

  app.post("/api/withdrawals", isAuthenticated, isNotFrozen, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ message: "User not found" });
      const amount = parseFloat(req.body.amount);
      if (isNaN(amount) || amount <= 0) return res.status(400).json({ message: "Invalid amount" });
      if (amount > parseFloat(user.balance)) return res.status(400).json({ message: "Insufficient balance" });

      const paymentMethod = req.body.paymentMethod || "bank";
      if (!["bank", "trc20"].includes(paymentMethod)) {
        return res.status(400).json({ message: "Payment method must be 'bank' or 'trc20'" });
      }
      if (paymentMethod === "bank" && (!req.body.bankDetails || !req.body.bankDetails.trim())) {
        return res.status(400).json({ message: "Bank details are required for bank withdrawal" });
      }
      if (paymentMethod === "trc20" && (!req.body.trc20Address || !req.body.trc20Address.trim())) {
        return res.status(400).json({ message: "TRC20 address is required for crypto withdrawal" });
      }

      const withdrawal = await storage.createWithdrawal({
        userId,
        storeId: req.body.storeId || null,
        amount: amount.toFixed(2),
        paymentMethod,
        bankDetails: req.body.bankDetails || null,
        trc20Address: req.body.trc20Address || null,
      });
      scheduleBackup(5);
      res.json(withdrawal);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/withdrawals/:id/status", isAuthenticated, isAdmin, async (req, res) => {
    const withdrawal = await storage.getWithdrawal(req.params.id);
    if (!withdrawal) return res.status(404).json({ message: "Withdrawal not found" });

    if (req.body.status === "approved" && withdrawal.status === "pending") {
      const user = await storage.getUser(withdrawal.userId);
      if (user) {
        const prevBal = parseFloat(user.balance);
        const newBalance = (prevBal - parseFloat(withdrawal.amount)).toFixed(2);
        await storage.updateUser(user.id, { balance: newBalance } as any);
        await storage.createRechargeRecord({
          userId: user.id,
          amount: (-parseFloat(withdrawal.amount)).toFixed(2),
          previousBalance: prevBal.toFixed(2),
          newBalance,
          rechargedBy: (req.user as any).id,
          note: `Withdrawal approved #${withdrawal.extractSn}`,
        });
      }
    }

    const updated = await storage.updateWithdrawalStatus(req.params.id, req.body.status);
    res.json(updated);
  });

  // Notices routes
  app.get("/api/notices", isAuthenticated, isAdmin, async (req, res) => {
    const all = await storage.getAllNotices();
    const linkedIds = await getLinkedUserIds(req);
    if (linkedIds === null) {
      res.json(all);
    } else {
      res.json(all.filter(n => linkedIds.includes(n.userId)));
    }
  });

  app.get("/api/notices/my", isAuthenticated, async (req, res) => {
    const userId = (req.user as any).id;
    const myNotices = await storage.getNoticesByUser(userId);
    res.json(myNotices);
  });

  app.post("/api/notices", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const notice = await storage.createNotice({
        storeId: req.body.storeId || null,
        userId: req.body.userId || null,
        type: req.body.type || "system",
        title: req.body.title,
        content: req.body.content || "",
      });

      if (req.body.userId) {
        const targetWs = clients.get(req.body.userId);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({ type: "notice", notice }));
        }
      }

      res.json(notice);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/notices/:id/seen", isAuthenticated, async (req, res) => {
    const updated = await storage.markNoticeSeen(req.params.id);
    if (!updated) return res.status(404).json({ message: "Notice not found" });
    res.json(updated);
  });

  // WebSocket server
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws, req) => {
    let userId: string | null = null;

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "auth" && msg.userId) {
          userId = msg.userId;
          clients.set(userId, ws);
        }
      } catch {}
    });

    ws.on("close", () => {
      if (userId) clients.delete(userId);
    });
  });

  // PostgreSQL LISTEN for cross-instance real-time sync
  // When any server instance (dev or prod) calls pg_notify('data_sync', ...),
  // all listening instances receive it and broadcast to their WS clients.
  let listenClient: InstanceType<typeof PgClient> | null = null;
  (function setupPgListen() {
    listenClient = new PgClient(
      process.env.SUPA_HOST
        ? { host: process.env.SUPA_HOST, user: process.env.SUPA_USER, password: process.env.SUPA_PASS, database: process.env.SUPA_DB || "postgres", port: parseInt(process.env.SUPA_PORT || "5432"), ssl: { rejectUnauthorized: false } }
        : { connectionString: process.env.DATABASE_URL }
    );
    listenClient.connect().then(() => {
      listenClient!.query("LISTEN data_sync");
      listenClient!.on("notification", (msg) => {
        try {
          const payload = JSON.parse(msg.payload || "{}");
          broadcastAll({ type: "data_sync", ...payload });
          console.log("[sync] broadcast:", payload.entity, payload.action, payload.id);
        } catch (err) {
          console.error("[sync] notification parse error:", err);
        }
      });
      listenClient!.on("error", (err) => {
        console.error("[sync] LISTEN client error:", err);
        setTimeout(setupPgListen, 5000);
      });
      console.log("[sync] PostgreSQL LISTEN active on channel 'data_sync'");
    }).catch((err) => {
      console.error("[sync] Failed to connect LISTEN client:", err);
      setTimeout(setupPgListen, 5000);
    });
  })();

  const cleanupListen = () => { listenClient?.end().catch(() => {}); };
  process.on("SIGTERM", cleanupListen);
  process.on("SIGINT", cleanupListen);

  // Site settings routes
  app.get("/api/site-settings", async (_req, res) => {
    try {
      const settings = await storage.getSiteSettings();
      res.json(settings);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/site-settings", isAuthenticated, isAdmin, async (req, res) => {
    try {
      const allowed = ["siteName", "contactEmail", "contactPhone", "contactAddress", "contactWhatsapp", "contactTelegram", "contactHours"];
      const data: any = {};
      for (const field of allowed) {
        if (req.body[field] !== undefined) data[field] = req.body[field];
      }
      const updated = await storage.updateSiteSettings(data);
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Seed data
  await seedDatabase();

  return httpServer;
}

async function seedDatabase() {
  try {
    const adminExists = await storage.getAdminUser();
    if (adminExists) return;

    function hashPassword(password: string): string {
      return crypto.createHash("sha256").update(password + "marketplacesalt").digest("hex");
    }

    const admin = await storage.createUser({
      email: "admin@marketplace.com",
      username: "admin",
      password: hashPassword("admin123"),
      age: 30,
      profession: "Platform Administrator",
      role: "superadmin",
      referenceCode: "REF-SUPERADMIN",
    } as any);

    const client1 = await storage.createUser({
      email: "sarah@example.com",
      username: "sarahtech",
      password: hashPassword("password123"),
      age: 28,
      profession: "Software Engineer",
    } as any);

    const client2 = await storage.createUser({
      email: "john@example.com",
      username: "johnfashion",
      password: hashPassword("password123"),
      age: 35,
      profession: "Fashion Designer",
    } as any);

    const client3 = await storage.createUser({
      email: "maya@example.com",
      username: "mayabooks",
      password: hashPassword("password123"),
      age: 26,
      profession: "Writer",
    } as any);

    // Stores
    const store1 = await storage.createStore({
      ownerId: client1.id,
      name: "TechHaven",
      description: "Your destination for premium tech gadgets, accessories, and electronics.",
      category: "Electronics",
      logoUrl: null,
    });

    const store2 = await storage.createStore({
      ownerId: client2.id,
      name: "StyleVault",
      description: "Curated fashion pieces and accessories for the modern lifestyle.",
      category: "Fashion",
      logoUrl: null,
    });

    const store3 = await storage.createStore({
      ownerId: client3.id,
      name: "BookNest",
      description: "A cozy collection of books, journals, and stationery for every reader.",
      category: "Books",
      logoUrl: null,
    });

    // Products
    await storage.createProduct({ storeId: store1.id, name: "Wireless Earbuds Pro", description: "High-quality wireless earbuds with noise cancellation and 30hr battery life.", price: "89.99", category: "Audio", imageUrl: null, stock: 50 });
    await storage.createProduct({ storeId: store1.id, name: "USB-C Hub 7-in-1", description: "Expand your connectivity with HDMI, USB 3.0, SD card, and more ports.", price: "45.99", category: "Accessories", imageUrl: null, stock: 30 });
    await storage.createProduct({ storeId: store1.id, name: "Mechanical Keyboard", description: "Tactile RGB mechanical keyboard with Cherry MX switches for the best typing experience.", price: "129.99", category: "Peripherals", imageUrl: null, stock: 20 });

    await storage.createProduct({ storeId: store2.id, name: "Leather Tote Bag", description: "Genuine leather tote bag, spacious and perfect for work or casual outings.", price: "75.00", category: "Bags", imageUrl: null, stock: 15 });
    await storage.createProduct({ storeId: store2.id, name: "Classic Denim Jacket", description: "Timeless denim jacket with a modern slim fit, suitable for all seasons.", price: "59.99", category: "Clothing", imageUrl: null, stock: 25 });

    await storage.createProduct({ storeId: store3.id, name: "The Art of Thinking Clearly", description: "A bestselling guide to cognitive biases and clearer decision making.", price: "18.99", category: "Self-Help", imageUrl: null, stock: 40 });
    await storage.createProduct({ storeId: store3.id, name: "Premium Leather Journal", description: "Handcrafted leather journal with 200 pages of premium paper.", price: "29.99", category: "Stationery", imageUrl: null, stock: 35 });

    // Admin Store (Official Catalog)
    const adminStore = await storage.createStore({
      ownerId: admin.id,
      name: "MarketNest Official",
      description: "Official MarketNest catalog. Browse and resell our curated products in your own store.",
      category: "Electronics",
      logoUrl: null,
    });

    await storage.createProduct({ storeId: adminStore.id, name: "Smart Watch Ultra", description: "Premium smartwatch with health tracking, GPS, and 7-day battery life.", price: "199.99", category: "Electronics", imageUrl: null, stock: 100, isAdminProduct: true });
    await storage.createProduct({ storeId: adminStore.id, name: "Portable Bluetooth Speaker", description: "Waterproof portable speaker with 360° sound and 24hr playtime.", price: "49.99", category: "Audio", imageUrl: null, stock: 200, isAdminProduct: true });
    await storage.createProduct({ storeId: adminStore.id, name: "Wireless Charging Pad", description: "Fast wireless charging pad compatible with all Qi-enabled devices.", price: "24.99", category: "Accessories", imageUrl: null, stock: 150, isAdminProduct: true });
    await storage.createProduct({ storeId: adminStore.id, name: "LED Desk Lamp", description: "Adjustable LED desk lamp with 5 brightness levels and USB charging port.", price: "34.99", category: "Electronics", imageUrl: null, stock: 80, isAdminProduct: true });

    // Targets
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 30);

    await storage.createTarget({
      userId: client1.id,
      assignedBy: admin.id,
      title: "Monthly Electronics Sales",
      description: "Reach $500 in total purchases from electronics stores this month.",
      targetAmount: "500.00",
      deadline,
    });

    await storage.createTarget({
      userId: client2.id,
      assignedBy: admin.id,
      title: "Fashion Bundle Goal",
      description: "Purchase fashion items worth $300 to unlock premium membership.",
      targetAmount: "300.00",
      deadline,
    });

    console.log("Seed data created successfully");
  } catch (err) {
    console.error("Seed error:", err);
  }
}
