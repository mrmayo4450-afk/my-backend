import type { Pool } from "pg";
type Result<T = any> = { ok: true; value: T } | { ok: false; status: number; message: string; details?: any };
const fail = (status: number, message: string, details?: any): Result => ({ ok: false, status, message, details });
const cents = (v: unknown): number | null => {
  const n = Number(v);
  const value = Number.isFinite(n) && n >= 0 ? Math.round((n + Number.EPSILON) * 100) : NaN;
  return Number.isSafeInteger(value) ? value : null;
};
const cash = (n: number) => (n / 100).toFixed(2);
const day = () => new Date().toISOString().slice(0, 10);

async function stats(c: any, userId: string, date: string, p = 0, s = 0, gain = 0) {
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [userId, date]);
  const { rows } = await c.query("SELECT id FROM user_daily_stats WHERE user_id=$1 AND date=$2 ORDER BY updated_at DESC LIMIT 1 FOR UPDATE", [userId, date]);
  if (rows.length) await c.query("UPDATE user_daily_stats SET purchases=purchases+$2::numeric,sales=sales+$3::numeric,profit=profit+$4::numeric,updated_at=now() WHERE id=$1", [rows[0].id, cash(p), cash(s), cash(gain)]);
  else await c.query("INSERT INTO user_daily_stats(user_id,date,purchases,sales,profit) VALUES($1,$2,$3,$4,$5)", [userId, date, cash(p), cash(s), cash(gain)]);
}
async function tx<T>(pool: Pool, fn: (c: any) => Promise<Result<T>>): Promise<Result<T>> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    if (!result.ok) { await c.query("ROLLBACK"); return result; }
    await c.query("COMMIT"); return result;
  } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; }
  finally { c.release(); }
}

export async function pickupOrder(pool: Pool, id: string, userId: string): Promise<Result<any>> {
  return tx(pool, async c => {
    const { rows } = await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id]);
    const o = rows[0];
    if (!o) return fail(404, "Order not found");
    if (o.buyer_id !== userId) return fail(403, "Forbidden");
    if (o.status !== "pending") return fail(400, "Order cannot be picked up");
    if (o.ordered_by && o.ordered_by !== o.buyer_id) {
      const cost = cents(o.total_price);
      if (cost === null || cost <= 0) return fail(400, "Order cost must be positive and valid");
      const b = await c.query("SELECT balance FROM users WHERE id=$1 FOR UPDATE", [userId]);
      const balance = cents(b.rows[0]?.balance);
      if (balance === null) return fail(404, "User not found or account balance is invalid");
      if (balance < cost) return fail(400, `Insufficient balance. You need $${cash(cost)} but have $${cash(balance)}. Please recharge first.`);
      await c.query("UPDATE users SET balance=$2 WHERE id=$1", [userId, cash(balance - cost)]);
      await c.query("INSERT INTO recharge_history(user_id,amount,previous_balance,new_balance,recharged_by,note) VALUES($1,$2,$3,$4,$1,$5)", [userId, cash(-cost), cash(balance), cash(balance - cost), `Order pickup #${o.order_sn}`]);
      await stats(c, userId, day(), cost);
    }
    const updated = await c.query("UPDATE orders SET status='processing' WHERE id=$1 AND status='pending' RETURNING *", [id]);
    return updated.rows.length ? { ok: true, value: updated.rows[0] } : fail(409, "Order status changed; refresh and try again");
  });
}
export async function pickupAllOrders(pool: Pool, userId: string): Promise<Result<{ updated: number }>> {
  return tx(pool, async c => {
    const { rows } = await c.query("SELECT * FROM orders WHERE buyer_id=$1 AND status='pending' ORDER BY id FOR UPDATE", [userId]);
    let cost = 0;
    for (const o of rows) if (o.ordered_by && o.ordered_by !== o.buyer_id) {
      const x = cents(o.total_price); if (x === null || x <= 0) return fail(400, `Order #${o.order_sn} has an invalid cost`); cost += x;
    }
    const b = await c.query("SELECT balance FROM users WHERE id=$1 FOR UPDATE", [userId]);
    const balance = cents(b.rows[0]?.balance);
    if (balance === null) return fail(404, "User not found or account balance is invalid");
    if (balance < cost) return fail(400, `Insufficient balance. You need $${cash(cost)} but have $${cash(balance)}. Please recharge first.`);
    if (rows.length) {
      const updated = await c.query("UPDATE orders SET status='processing' WHERE id=ANY($1::varchar[]) AND status='pending' RETURNING id", [rows.map((o: any) => o.id)]);
      if (updated.rows.length !== rows.length) return fail(409, "Orders changed; refresh and try again");
    }
    if (cost) {
      await c.query("UPDATE users SET balance=$2 WHERE id=$1", [userId, cash(balance - cost)]);
      await c.query("INSERT INTO recharge_history(user_id,amount,previous_balance,new_balance,recharged_by,note) VALUES($1,$2,$3,$4,$1,$5)", [userId, cash(-cost), cash(balance), cash(balance - cost), `Bulk pickup of ${rows.length} order(s)`]);
      await stats(c, userId, day(), cost);
    }
    return { ok: true, value: { updated: rows.length } };
  });
}
export async function completeOrder(pool: Pool, id: string): Promise<Result<any>> {
  return tx(pool, async c => {
    const { rows } = await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id]); const o = rows[0];
    if (!o) return fail(404, "Order not found");
    if (o.status !== "processing") return fail(400, "Only processing orders can be completed");
    if (o.ordered_by && o.ordered_by !== o.buyer_id) {
      const sale = cents(o.pay_price); const gain = cents(o.profit);
      if (sale === null || sale <= 0 || gain === null) return fail(400, "Order selling amount or profit is invalid");
      const b = await c.query("SELECT balance FROM users WHERE id=$1 FOR UPDATE", [o.buyer_id]); const balance = cents(b.rows[0]?.balance);
      if (balance === null) return fail(404, "Order owner not found or account balance is invalid");
      await c.query("UPDATE users SET balance=$2 WHERE id=$1", [o.buyer_id, cash(balance + sale)]);
      await c.query("INSERT INTO recharge_history(user_id,amount,previous_balance,new_balance,recharged_by,note) VALUES($1,$2,$3,$4,$5,$6)", [o.buyer_id, cash(sale), cash(balance), cash(balance + sale), o.ordered_by, `Order completion #${o.order_sn}`]);
      await stats(c, o.buyer_id, day(), 0, sale, gain);
    }
    const updated = await c.query("UPDATE orders SET status='completed' WHERE id=$1 AND status='processing' RETURNING *", [id]);
    return updated.rows.length ? { ok: true, value: updated.rows[0] } : fail(409, "Order status changed; refresh and try again");
  });
}
export async function acceptBulkOrder(pool: Pool, id: string, userId: string): Promise<Result<any>> {
  return tx(pool, async c => {
    const { rows } = await c.query("SELECT * FROM bulk_orders WHERE id=$1 FOR UPDATE", [id]); const o = rows[0];
    if (!o) return fail(404, "Bulk order not found");
    const store = await c.query("SELECT owner_id FROM stores WHERE id=$1", [o.store_id]);
    if (store.rows[0]?.owner_id !== userId) return fail(403, "You do not own this store");
    if (o.status !== "pending") return fail(400, `Order is already ${o.status}`);
    const expired = await c.query("UPDATE bulk_orders SET status='expired' WHERE id=$1 AND status='pending' AND expires_at < now() RETURNING status", [id]);
    if (expired.rows.length) return { ok: true, value: { status: "expired", expired: true } };
    const cost = cents(o.total_cost); if (cost === null || cost <= 0) return fail(400, "Bulk order cost must be positive and valid");
    const b = await c.query("SELECT balance FROM users WHERE id=$1 FOR UPDATE", [userId]); const balance = cents(b.rows[0]?.balance);
    if (balance === null) return fail(404, "User not found or account balance is invalid");
    if (balance < cost) return fail(400, `Insufficient balance. You need $${cash(cost)} but have $${cash(balance)}. Please contact customer service to top up your account.`, { insufficientBalance: true, required: cost / 100, available: balance / 100 });
    await c.query("UPDATE users SET balance=$2 WHERE id=$1", [userId, cash(balance - cost)]);
    await c.query("INSERT INTO recharge_history(user_id,amount,previous_balance,new_balance,recharged_by,note) VALUES($1,$2,$3,$4,$1,$5)", [userId, cash(-cost), cash(balance), cash(balance - cost), `Bulk order payment ${o.batch_sn}`]);
    await stats(c, userId, day(), cost);
    const updated = await c.query("UPDATE bulk_orders SET status='accepted',accepted_at=now() WHERE id=$1 AND status='pending' RETURNING *", [id]);
    return updated.rows.length ? { ok: true, value: updated.rows[0] } : fail(409, "Bulk order status changed; refresh and try again");
  });
}
export async function updateBulkOrder(pool: Pool, id: string, actorId: string, superAdmin: boolean, body: any): Promise<Result<any>> {
  return tx(pool, async c => {
    const { rows } = await c.query("SELECT * FROM bulk_orders WHERE id=$1 FOR UPDATE", [id]); const o = rows[0];
    if (!o) return fail(404, "Bulk order not found");
    if (body.status === "completed" && o.status === "completed") return fail(400, "Bulk order is already completed");
    if (body.totalCost !== undefined || body.totalProfit !== undefined) return fail(400, "Financial totals cannot be edited; create a corrected order instead");
    if (body.status !== undefined && body.status !== o.status) {
      if (body.status === "completed" && o.status !== "accepted") return fail(400, "Only accepted bulk orders can be completed");
      if (body.status !== "completed" && !(o.status === "pending" && ["declined", "expired"].includes(body.status))) return fail(400, "Arbitrary bulk order status transitions are not allowed");
      if (body.status === "completed") {
        if (!superAdmin) {
          const linked = await c.query("SELECT 1 FROM stores s JOIN users u ON u.id=s.owner_id WHERE s.id=$1 AND u.referred_by=$2", [o.store_id, actorId]);
          if (!linked.rows.length) return fail(403, "You can only complete bulk orders for linked store owners");
        }
        const cost = cents(o.total_cost); const profit = cents(o.total_profit);
        if (cost === null || cost <= 0 || profit === null) return fail(400, "Bulk order financial totals are invalid");
        const store = await c.query("SELECT owner_id FROM stores WHERE id=$1", [o.store_id]); const owner = store.rows[0]?.owner_id;
        if (!owner) return fail(404, "Store not found");
        const b = await c.query("SELECT balance FROM users WHERE id=$1 FOR UPDATE", [owner]); const balance = cents(b.rows[0]?.balance);
        if (balance === null) return fail(404, "Store owner not found or account balance is invalid");
        const sale = cost + profit;
        await c.query("UPDATE users SET balance=$2 WHERE id=$1", [owner, cash(balance + sale)]);
        await c.query("INSERT INTO recharge_history(user_id,amount,previous_balance,new_balance,recharged_by,note) VALUES($1,$2,$3,$4,$5,$6)", [owner, cash(sale), cash(balance), cash(balance + sale), actorId, `Bulk order completion ${o.batch_sn}`]);
        await stats(c, owner, day(), 0, sale, profit);
      }
    }
    const sets: string[] = []; const vals: any[] = [id];
    const add = (col: string, val: any) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };
    if (body.status !== undefined && body.status !== o.status) add("status", body.status);
    if (body.shippingAddress !== undefined) add("shipping_address", body.shippingAddress);
    if (body.note !== undefined) add("note", body.note);
    if (body.extendHours !== undefined) {
      const h = Number(body.extendHours); if (!Number.isFinite(h) || h <= 0) return fail(400, "extendHours must be a positive number");
      add("expires_at", new Date(Math.max(Date.now(), new Date(o.expires_at).getTime()) + h * 3600000));
    }
    if (!sets.length) return { ok: true, value: { ...o, statusChanged: false } };
    const result = await c.query(`UPDATE bulk_orders SET ${sets.join(",")} WHERE id=$1 RETURNING *`, vals);
    return { ok: true, value: { ...result.rows[0], statusChanged: body.status !== undefined && body.status !== o.status } };
  });
}

export async function createDirectPurchase(
  pool: Pool,
  buyerId: string,
  productId: string,
  quantity: number,
  orderData: any,
  buyForStoreId?: string,
): Promise<Result<any>> {
  return tx(pool, async c => {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) return fail(400, "Quantity must be a positive whole number");
    if (buyForStoreId) {
      const targetStore = await c.query("SELECT id,owner_id FROM stores WHERE id=$1 FOR UPDATE", [buyForStoreId]);
      if (!targetStore.rows.length) return fail(404, "Target store not found");
      if (targetStore.rows[0].owner_id !== buyerId) return fail(403, "You can only stock products in your own store");
    }
    const productResult = await c.query("SELECT id,store_id,price,stock,name,description,category,image_url FROM products WHERE id=$1 FOR UPDATE", [productId]);
    const product = productResult.rows[0];
    if (!product) return fail(404, "Product not found");
    const unitCost = cents(product.price);
    if (unitCost === null || unitCost <= 0) return fail(400, "Product price must be a positive finite amount");
    const total = unitCost * quantity;
    if (!Number.isSafeInteger(total)) return fail(400, "Purchase total is invalid");
    if (Number(product.stock) < quantity) return fail(400, "Insufficient stock");
    let resellProduct: any = null;
    if (buyForStoreId) {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [buyForStoreId, product.name]);
      const matching = await c.query(
        "SELECT id,stock FROM products WHERE store_id=$1 AND (admin_product_id=$2 OR name=$3) ORDER BY CASE WHEN admin_product_id=$2 THEN 0 ELSE 1 END LIMIT 1 FOR UPDATE",
        [buyForStoreId, productId, product.name],
      );
      resellProduct = matching.rows[0] || null;
    }
    const balanceResult = await c.query("SELECT balance FROM users WHERE id=$1 FOR UPDATE", [buyerId]);
    if (!balanceResult.rows.length) return fail(404, "User not found");
    const balance = cents(balanceResult.rows[0].balance);
    if (balance === null) return fail(400, "Account balance is invalid");
    if (balance < total) return fail(400, "Insufficient balance. Please recharge your account before purchasing.");
    const stock = await c.query("UPDATE products SET stock=stock-$2 WHERE id=$1 AND stock >= $2 RETURNING id", [productId, quantity]);
    if (!stock.rows.length) return fail(400, "Insufficient stock");
    const next = balance - total;
    const debit = await c.query("UPDATE users SET balance=$2 WHERE id=$1 AND balance >= $3 RETURNING id", [buyerId, cash(next), cash(total)]);
    if (!debit.rows.length) return fail(400, "Insufficient balance. Please recharge your account before purchasing.");
    const inserted = await c.query(
      `INSERT INTO orders(buyer_id,product_id,store_id,quantity,total_price,pay_price,profit,status,remark,delivery_address,ordered_by,deliver_to_user_id,batch_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id,order_sn AS "orderSn",batch_id AS "batchId",buyer_id AS "buyerId",product_id AS "productId",
         store_id AS "storeId",quantity,total_price AS "totalPrice",pay_price AS "payPrice",profit,status,remark,
         delivery_address AS "deliveryAddress",ordered_by AS "orderedBy",deliver_to_user_id AS "deliverToUserId",created_at AS "createdAt"`,
      [buyerId, productId, product.store_id, quantity, cash(total), "0", "0",
        "pending", orderData.remark ?? "", orderData.deliveryAddress ?? null, null,
        orderData.deliverToUserId ?? null, null],
    );
    await c.query("INSERT INTO recharge_history(user_id,amount,previous_balance,new_balance,recharged_by,note) VALUES($1,$2,$3,$4,$1,$5)",
      [buyerId, cash(-total), cash(balance), cash(next), "Product purchase"]);
    await stats(c, buyerId, day(), total);
    if (buyForStoreId) {
      if (resellProduct) {
        await c.query("UPDATE products SET stock=stock+$2,price=$3 WHERE id=$1", [resellProduct.id, quantity, product.price]);
      } else {
        await c.query(
          "INSERT INTO products(store_id,name,description,price,cost_price,category,image_url,stock,is_admin_product,admin_product_id) VALUES($1,$2,$3,$4,$4,$5,$6,$7,false,$8)",
          [buyForStoreId, product.name, product.description, product.price, product.category, product.image_url, quantity, productId],
        );
      }
    }
    return { ok: true, value: { order: inserted.rows[0], productStoreId: product.store_id, totalCost: cash(total) } };
  });
}

export async function cancelPendingOrder(pool: Pool, id: string): Promise<Result<any>> {
  return tx(pool, async c => {
    const { rows } = await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id]); const o = rows[0];
    if (!o) return fail(404, "Order not found");
    const wasAdminAssigned = Boolean(o.ordered_by && o.ordered_by !== o.buyer_id);
    if (!wasAdminAssigned) {
      return fail(409, "Paid direct purchase orders cannot be cancelled here. Contact Support to request a manual refund.");
    }
    const assigningAdmin = await c.query("SELECT 1 FROM users WHERE id=$1 AND role IN ('admin','superadmin')", [o.ordered_by]);
    if (!assigningAdmin.rows.length) {
      return fail(409, "Paid direct purchase orders cannot be cancelled here. Contact Support to request a manual refund.");
    }
    if (o.status !== "pending") return fail(400, "Only pending orders can be cancelled");
    const updated = await c.query(
      `UPDATE orders SET status='cancelled' WHERE id=$1 AND status='pending'
       RETURNING id,order_sn AS "orderSn",batch_id AS "batchId",buyer_id AS "buyerId",product_id AS "productId",
         store_id AS "storeId",quantity,total_price AS "totalPrice",pay_price AS "payPrice",profit,status,remark,
         delivery_address AS "deliveryAddress",ordered_by AS "orderedBy",deliver_to_user_id AS "deliverToUserId",created_at AS "createdAt"`,
      [id],
    );
    if (!updated.rows.length) return fail(409, "Order status changed; refresh and try again");
    const stock = await c.query(
      "UPDATE products SET stock=stock+$2,sales_count=CASE WHEN $3 THEN greatest(0,sales_count-$2) ELSE sales_count END WHERE id=$1 RETURNING id",
      [o.product_id, o.quantity, wasAdminAssigned],
    );
    if (!stock.rows.length) return fail(404, "Order product not found");
    return { ok: true, value: updated.rows[0] };
  });
}

export async function expireBulkOrderIfPending(pool: Pool, id: string): Promise<{ status: string; changed: boolean } | null> {
  const c = await pool.connect();
  try {
    const changed = await c.query("UPDATE bulk_orders SET status='expired' WHERE id=$1 AND status='pending' AND expires_at < now() RETURNING status", [id]);
    if (changed.rows.length) return { status: changed.rows[0].status, changed: true };
    const current = await c.query("SELECT status FROM bulk_orders WHERE id=$1", [id]);
    return current.rows[0] ? { status: current.rows[0].status, changed: false } : null;
  } finally { c.release(); }
}

export async function adminUpdateUserFinance(
  pool: Pool,
  userId: string,
  actorId: string,
  updates: Record<string, any>,
  note: string,
): Promise<Result<any>> {
  return tx(pool, async c => {
    const selected = await c.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [userId]);
    const current = selected.rows[0];
    if (!current) return fail(404, "User not found");
    const columns: Record<string, string> = {
      grade: "grade", credit: "credit", goodRate: "good_rate", phone: "phone", vipLevel: "vip_level", rating: "rating",
    };
    const sets: string[] = []; const values: any[] = [userId];
    const previous = cents(current.balance);
    if (previous === null) return fail(400, "Account balance is invalid");
    if (updates.balance !== undefined) {
      if ((typeof updates.balance !== "number" && typeof updates.balance !== "string") ||
        (typeof updates.balance === "string" && updates.balance.trim() === "")) return fail(400, "Balance must be a finite non-negative amount");
      const target = cents(updates.balance);
      if (target === null) return fail(400, "Balance must be a finite non-negative amount");
      values.push(cash(target)); sets.push(`balance=$${values.length}`);
      if (target !== previous) {
        await c.query("INSERT INTO recharge_history(user_id,amount,previous_balance,new_balance,recharged_by,note) VALUES($1,$2,$3,$4,$5,$6)",
          [userId, cash(target - previous), cash(previous), cash(target), actorId, note]);
      }
    }
    for (const [field, column] of Object.entries(columns)) if (updates[field] !== undefined) {
      values.push(updates[field]); sets.push(`${column}=$${values.length}`);
    }
    if (sets.length) await c.query(`UPDATE users SET ${sets.join(",")} WHERE id=$1`, values);
    const result = await c.query(
      `SELECT id,email,username,password,age,profession,phone,role,is_frozen AS "isFrozen",balance,grade,credit,
       good_rate AS "goodRate",vip_level AS "vipLevel",rating,reference_code AS "referenceCode",
       referred_by AS "referredBy",created_at AS "createdAt" FROM users WHERE id=$1`,
      [userId],
    );
    return { ok: true, value: result.rows[0] };
  });
}

export async function updateWithdrawalStatusFinancial(
  pool: Pool,
  withdrawalId: string,
  actorId: string,
  requestedStatus: unknown,
): Promise<Result<any>> {
  return tx(pool, async c => {
    if (requestedStatus !== "approved" && requestedStatus !== "rejected") return fail(400, "Withdrawal status must be approved or rejected");
    const selected = await c.query("SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE", [withdrawalId]);
    const withdrawal = selected.rows[0];
    if (!withdrawal) return fail(404, "Withdrawal not found");
    if (withdrawal.status !== "pending") return fail(400, `Only pending withdrawals can be ${requestedStatus}`);
    if (requestedStatus === "approved") {
      const amount = cents(withdrawal.amount);
      if (amount === null || amount <= 0) return fail(400, "Withdrawal amount must be positive and valid");
      const balanceResult = await c.query("SELECT balance FROM users WHERE id=$1 FOR UPDATE", [withdrawal.user_id]);
      if (!balanceResult.rows.length) return fail(404, "Withdrawal user not found");
      const balance = cents(balanceResult.rows[0].balance);
      if (balance === null) return fail(400, "Account balance is invalid");
      if (balance < amount) return fail(400, "Insufficient balance to approve this withdrawal");
      const next = balance - amount;
      const debited = await c.query("UPDATE users SET balance=$2 WHERE id=$1 AND balance >= $3 RETURNING id",
        [withdrawal.user_id, cash(next), cash(amount)]);
      if (!debited.rows.length) return fail(400, "Insufficient balance to approve this withdrawal");
      await c.query("INSERT INTO recharge_history(user_id,amount,previous_balance,new_balance,recharged_by,note) VALUES($1,$2,$3,$4,$5,$6)",
        [withdrawal.user_id, cash(-amount), cash(balance), cash(next), actorId, `Withdrawal approved #${withdrawal.extract_sn}`]);
    }
    const updated = await c.query(
      `UPDATE withdrawals SET status=$2 WHERE id=$1 AND status='pending'
       RETURNING id,user_id AS "userId",store_id AS "storeId",extract_sn AS "extractSn",amount,
         payment_method AS "paymentMethod",bank_details AS "bankDetails",trc20_address AS "trc20Address",status,
         created_at AS "createdAt"`,
      [withdrawalId, requestedStatus],
    );
    return updated.rows.length ? { ok: true, value: updated.rows[0] } : fail(409, "Withdrawal status changed; refresh and try again");
  });
}