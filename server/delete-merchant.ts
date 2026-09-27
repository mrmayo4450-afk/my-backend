import type { Pool } from "pg";

type DeleteResult =
  | { ok: true; storesDeleted: number }
  | { ok: false; status: number; message: string };

// Keep the account and every dependent row in one transaction. A failed
// constraint or concurrent write must never leave a partially deleted account.
export async function permanentlyDeleteMerchant(
  pool: Pool,
  merchantId: string,
  requiredStoreId?: string,
  allowedRole: "client" | "admin" = "client",
): Promise<DeleteResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query("SELECT role, reference_code FROM users WHERE id = $1 FOR UPDATE", [merchantId]);
    if (!selected.rows.length || selected.rows[0].role !== allowedRole) {
      await client.query("ROLLBACK");
      return { ok: false, status: 404, message: `${allowedRole === "admin" ? "Admin" : "Merchant"} not found` };
    }
    const owned = await client.query("SELECT id FROM stores WHERE owner_id = $1 FOR UPDATE", [merchantId]);
    if (requiredStoreId && !owned.rows.some((row: { id: string }) => row.id === requiredStoreId)) {
      await client.query("ROLLBACK");
      return { ok: false, status: 404, message: "Store not found" };
    }

    // These foreign keys point at the deleted user from surviving accounts.
    await client.query("UPDATE users SET referred_by = NULL WHERE referred_by = $1", [merchantId]);
    await client.query("UPDATE user_daily_stats SET set_by = NULL WHERE set_by = $1 AND user_id <> $1", [merchantId]);
    if (selected.rows[0].reference_code) {
      await client.query("UPDATE stores SET reference_code = NULL WHERE reference_code = $1", [selected.rows[0].reference_code]);
    }
    // Some older databases contain this audit table although it is absent
    // from the current Drizzle schema. Its actor FK would block user deletion.
    const auditTable = await client.query("SELECT to_regclass('public.admin_actions') AS name");
    if (auditTable.rows[0]?.name) {
      await client.query(
        `DELETE FROM admin_actions WHERE actor_id = $1 OR target_id = $1
          OR target_id IN (SELECT id FROM stores WHERE owner_id = $1)
          OR target_id IN (SELECT id FROM products WHERE store_id IN (SELECT id FROM stores WHERE owner_id = $1))
          OR target_id IN (SELECT id FROM orders WHERE buyer_id = $1 OR ordered_by = $1 OR deliver_to_user_id = $1
            OR store_id IN (SELECT id FROM stores WHERE owner_id = $1))
          OR target_id IN (SELECT id FROM bulk_orders WHERE admin_id = $1 OR store_id IN (SELECT id FROM stores WHERE owner_id = $1))
          OR target_email = (SELECT email FROM users WHERE id = $1)`,
        [merchantId],
      );
    }

    await client.query("DELETE FROM password_reset_requests WHERE user_id = $1", [merchantId]);
    await client.query("DELETE FROM chat_messages WHERE sender_id = $1 OR receiver_id = $1", [merchantId]);
    await client.query("DELETE FROM targets WHERE user_id = $1 OR assigned_by = $1", [merchantId]);
    await client.query("DELETE FROM withdrawals WHERE user_id = $1 OR store_id IN (SELECT id FROM stores WHERE owner_id = $1)", [merchantId]);
    await client.query("DELETE FROM merchant_notices WHERE user_id = $1 OR store_id IN (SELECT id FROM stores WHERE owner_id = $1)", [merchantId]);
    await client.query("DELETE FROM recharge_history WHERE user_id = $1 OR recharged_by = $1", [merchantId]);
    await client.query("DELETE FROM user_daily_stats WHERE user_id = $1", [merchantId]);
    await client.query(
      `DELETE FROM bulk_order_items WHERE bulk_order_id IN
        (SELECT id FROM bulk_orders WHERE admin_id = $1 OR store_id IN (SELECT id FROM stores WHERE owner_id = $1))
        OR product_id IN (SELECT id FROM products WHERE store_id IN (SELECT id FROM stores WHERE owner_id = $1))`,
      [merchantId],
    );
    await client.query(
      "DELETE FROM bulk_orders WHERE admin_id = $1 OR store_id IN (SELECT id FROM stores WHERE owner_id = $1)",
      [merchantId],
    );
    await client.query(
      `DELETE FROM orders WHERE buyer_id = $1 OR ordered_by = $1 OR deliver_to_user_id = $1
        OR store_id IN (SELECT id FROM stores WHERE owner_id = $1)
        OR product_id IN (SELECT id FROM products WHERE store_id IN (SELECT id FROM stores WHERE owner_id = $1))`,
      [merchantId],
    );
    await client.query(
      "DELETE FROM product_images WHERE product_id IN (SELECT id FROM products WHERE store_id IN (SELECT id FROM stores WHERE owner_id = $1))",
      [merchantId],
    );
    await client.query("DELETE FROM products WHERE store_id IN (SELECT id FROM stores WHERE owner_id = $1)", [merchantId]);
    await client.query("DELETE FROM stores WHERE owner_id = $1", [merchantId]);
    await client.query("DELETE FROM session WHERE sess -> 'passport' ->> 'user' = $1", [merchantId]);
    await client.query("DELETE FROM users WHERE id = $1", [merchantId]);
    // Stored snapshots must not retain or restore an account that was erased.
    // New snapshots are scheduled after commit by the caller.
    await client.query("DELETE FROM backups WHERE label IN ('current', 'previous', 'images')");
    await client.query("COMMIT");
    return { ok: true, storesDeleted: owned.rows.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}