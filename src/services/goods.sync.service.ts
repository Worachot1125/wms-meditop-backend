import { prisma } from "../lib/prisma";
import { SyncResult } from "../types/event_goods";
import { logger } from "../lib/logger";

type NormalizedGoods = {
  product_id: number;
  product_code?: string | null;
  product_name?: string | null;
  product_type?: string | null;

  lot_id?: number | null;
  lot_name?: string | null;
  expiration_date?: string | Date | null;

  department_id?: number | null;
  department_code?: string | null;
  department_name?: string | null;

  unit?: string | null;

  zone_id?: number | null;
  zone_type?: string | null;

  tracking?: string | null;
  user_manaul_url?: string | null;

  active?: boolean | null;

  product_last_modified_date?: string | Date | null;
  lot_last_modified_date?: string | Date | null;
};

function toDateOrNull(v: any): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toBangkokDatePlus7OrNull(v: any): Date | null {
  if (!v) return null;

  const d = v instanceof Date ? new Date(v.getTime()) : new Date(v);
  if (Number.isNaN(d.getTime())) return null;

  // ขยับ +7 ชั่วโมง เพื่อให้ exp จาก Odoo กลายเป็นเวลาไทย
  d.setHours(d.getHours() + 7);
  return d;
}

function cleanText(v: unknown): string {
  return String(v ?? "").trim();
}

/**
 * รองรับทั้ง payload จาก webhook (code/name/type/department/zone)
 * และ payload จาก Odoo view (product_code/product_name/product_type/department_code/zone_type)
 */
export function normalizeGoods(item: any): NormalizedGoods {
  return {
    product_id: Number(item.product_id),

    product_code: item.product_code ?? item.code ?? null,
    product_name: item.product_name ?? item.name ?? null,
    product_type: item.product_type ?? item.type ?? null,

    lot_id:
      item.lot_id !== undefined && item.lot_id !== null ? Number(item.lot_id) : null,
    lot_name: item.lot_name ?? null,
    expiration_date: item.expiration_date ?? null,

    department_id:
      item.department_id !== undefined && item.department_id !== null
        ? Number(item.department_id)
        : null,
    department_code: item.department_code ?? null,
    department_name: item.department_name ?? item.department ?? null,

    unit: item.unit ?? null,

    zone_id:
      item.zone_id !== undefined && item.zone_id !== null ? Number(item.zone_id) : null,
    zone_type: item.zone_type ?? item.zone ?? null,

    tracking: item.tracking ?? null,
    user_manaul_url: item.user_manaul_url ?? null,

    active: item.active !== false,

    product_last_modified_date: item.product_last_modified_date ?? null,
    lot_last_modified_date: item.lot_last_modified_date ?? null,
  };
}

/**
 * ✅ preload map: product_code(SKU) -> input_number
 * (ใน schema ของคุณ input_number เป็น boolean (not nullable) อยู่แล้ว)
 */
async function buildInputNumberBySkuMap(skus: string[]) {
  const cleanSkus = Array.from(
    new Set(
      (skus || [])
        .map((s) => String(s ?? "").trim())
        .filter((s) => s.length > 0),
    ),
  );

  const map = new Map<string, boolean>();
  if (cleanSkus.length === 0) return map;

  const rows = await prisma.wms_mdt_goods.findMany({
    where: {
      product_code: { in: cleanSkus },
    },
    select: { product_code: true, input_number: true, id: true },
    orderBy: { id: "asc" },
  });

  for (const r of rows) {
    const sku = cleanText(r.product_code);
    if (!sku) continue;
    if (map.has(sku)) continue;
    map.set(sku, Boolean(r.input_number));
  }

  return map;
}

/**
 * ✅ preload map: product_code(SKU) -> zone_type
 * policy:
 * - ถ้า SKU เดิมใน DB มี zone_type ที่ไม่ว่างอยู่แล้ว
 *   ให้ใช้ค่าแรกที่เจอเป็นค่า inherit ของทั้งกลุ่ม SKU
 */
async function buildZoneTypeBySkuMap(skus: string[]) {
  const cleanSkus = Array.from(
    new Set(
      (skus || [])
        .map((s) => String(s ?? "").trim())
        .filter((s) => s.length > 0),
    ),
  );

  const map = new Map<string, string>();
  if (cleanSkus.length === 0) return map;

  const rows = await prisma.wms_mdt_goods.findMany({
    where: {
      product_code: { in: cleanSkus },
    },
    select: {
      id: true,
      product_code: true,
      zone_type: true,
    },
    orderBy: { id: "asc" },
  });

  for (const r of rows) {
    const sku = cleanText(r.product_code);
    const zoneType = cleanText(r.zone_type);

    if (!sku) continue;
    if (!zoneType) continue;
    if (map.has(sku)) continue;

    map.set(sku, zoneType);
  }

  return map;
}

export class GoodsSyncService {
  /**
   * Pull/Push ได้หมด: รับ array goods แล้ว sync เข้า wms_mdt_goods
   * ไม่ assume ว่า product_id unique
   *
   * ✅ policy เพิ่ม:
   * 1) input_number ต้อง inherit ตามกลุ่ม SKU (product_code)
   * 2) zone_type ต้อง inherit ตามกลุ่ม SKU (product_code)
   *    - ถ้า SKU เดิมใน DB มี zone_type อยู่แล้ว
   *      create/update ใหม่ต้องใช้ค่าเดียวกัน
   */
  async syncGoods(odooGoodsRaw: any[], triggeredBy: string = "system"): Promise<SyncResult> {
    const startTime = new Date();
    const result: SyncResult = {
      created: 0,
      updated: 0,
      disabled: 0,
      total_processed: 0,
      errors: [],
    };

    let syncLogId: number | null = null;

    const odooGoods = (odooGoodsRaw || []).map(normalizeGoods);

    const incomingSkus = odooGoods
      .map((g) => cleanText(g.product_code))
      .filter(Boolean);

    // ✅ preload กลุ่ม SKU เดิมจาก DB
    const inputNumberBySku = await buildInputNumberBySkuMap(incomingSkus);
    const zoneTypeBySku = await buildZoneTypeBySkuMap(incomingSkus);

    logger.info("🔄 Starting goods sync from Odoo...", {
      triggeredBy,
      recordCount: odooGoods.length,
    });

    try {
      const syncLog = await prisma.odoo_sync_log.create({
        data: {
          entity_type: "goods",
          sync_type: triggeredBy === "system" ? "scheduled" : "manual",
          status: "start",
          started_at: startTime,
          triggered_by: triggeredBy,
          records_fetched: odooGoods.length,
        },
      });
      syncLogId = syncLog.id;
      logger.info(`📝 Created sync log ID: ${syncLogId}`);

      const odooProductIds = [...new Set(odooGoods.map((g) => g.product_id))];

      for (const odooItem of odooGoods) {
        try {
          await this.processGoodsItem(
            odooItem,
            result,
            inputNumberBySku,
            zoneTypeBySku,
          );
        } catch (error: any) {
          const errorMsg = `Error processing product_id ${odooItem.product_id}: ${error.message}`;
          result.errors?.push(errorMsg);
          logger.error(`❌ ${errorMsg}`);
        }
      }

      const MIN_ROWS_TO_ALLOW_DISABLE = Number(
        process.env.SYNC_MIN_ROWS_TO_DISABLE || "50",
      );
      const allowDisable = odooGoods.length >= MIN_ROWS_TO_ALLOW_DISABLE;

      if (!allowDisable) {
        logger.warn(
          `⛔ Skip disabling goods (fetched=${odooGoods.length} < ${MIN_ROWS_TO_ALLOW_DISABLE}). Prevent accidental mass-disable.`,
        );
      } else {
        logger.info("🔍 Checking for goods to disable (by product_id)...");
        const disabledCount = await prisma.wms_mdt_goods.updateMany({
          where: {
            product_id: { notIn: odooProductIds },
            active: true,
          },
          data: { active: false },
        });
        result.disabled = disabledCount.count;

        if (disabledCount.count > 0) {
          logger.warn(`⛔ Disabled ${disabledCount.count} goods not found in Odoo`);
        } else {
          logger.info("✅ No goods need to be disabled");
        }
      }

      result.total_processed = odooGoods.length;

      const duration = Date.now() - startTime.getTime();
      const hasErrors = result.errors && result.errors.length > 0;

      logger.info(
        `${hasErrors ? "⚠️ PARTIAL SUCCESS" : "✅ SUCCESS"} Goods sync completed in ${duration}ms (${
          duration / 60000
        } minutes)`,
      );
      logger.info(
        `📊 Summary: Created=${result.created}, Updated=${result.updated}, Disabled=${result.disabled}, Errors=${result.errors?.length || 0}`,
      );

      if (syncLogId) {
        await prisma.odoo_sync_log.update({
          where: { id: syncLogId },
          data: {
            status: "done",
            completed_at: new Date(),
            records_fetched: odooGoods.length,
            records_created: result.created,
            records_updated: result.updated,
            records_disabled: result.disabled,
            error_message: hasErrors ? result.errors!.join("; ") : null,
          },
        });
      }

      return result;
    } catch (error: any) {
      logger.error("❌ FAILED Goods sync error:", error);

      if (syncLogId) {
        const stackTrace = error.stack || undefined;
        await prisma.odoo_sync_log.update({
          where: { id: syncLogId },
          data: {
            status: "error",
            completed_at: new Date(),
            error_message: stackTrace
              ? `${error.message}\n\nStack trace:\n${stackTrace}`
              : error.message,
          },
        });
      }

      throw error;
    }
  }

  /**
   * Natural key (ไม่แตะ schema):
   * ใช้ (product_id, lot_id, department_code, zone_type) เพื่อระบุ "แถวเดียว" ตาม Odoo view
   *
   * ✅ input_number policy:
   * - ถ้า SKU นี้เคยมีค่า input_number ใน DB => inherit ค่าเดิมก่อน create/update
   *
   * ✅ zone_type policy:
   * - ถ้า SKU นี้เคยมี zone_type ใน DB => inherit ค่าเดิมก่อน create/update
   * - ถ้ายังไม่มีใน DB แต่ item ปัจจุบันมี zone_type => จำค่าไว้ให้ item ถัดไปใน batch เดียวกัน
   */
  private async processGoodsItem(
    odooItem: NormalizedGoods,
    result: SyncResult,
    inputNumberBySku: Map<string, boolean>,
    zoneTypeBySku: Map<string, string>,
  ): Promise<void> {
    if (!odooItem.product_id) throw new Error("Missing product_id");

    const sku = cleanText(odooItem.product_code);
    const incomingZoneType = cleanText(odooItem.zone_type);

    const groupInput =
      sku && inputNumberBySku.has(sku) ? inputNumberBySku.get(sku)! : undefined;

    const inheritedZoneType =
      sku && zoneTypeBySku.has(sku) ? zoneTypeBySku.get(sku)! : undefined;

    // ✅ ถ้า SKU เดิมมี zone_type อยู่แล้ว ให้ใช้ค่านั้น
    // ไม่งั้นใช้ค่าที่มาจาก Odoo ตามปกติ
    const finalZoneType = inheritedZoneType ?? (incomingZoneType || null);

    const whereKey = {
      product_id: odooItem.product_id,
      lot_id: odooItem.lot_id ?? null,
      department_code: odooItem.department_code ?? null,
      zone_type: finalZoneType,
    };

    const dataToSave: any = {
      product_id: odooItem.product_id,
      product_code: odooItem.product_code ?? null,
      product_name: odooItem.product_name ?? null,
      product_type: odooItem.product_type ?? null,

      lot_id: odooItem.lot_id ?? null,
      lot_name: odooItem.lot_name ?? null,
      expiration_date: toBangkokDatePlus7OrNull(odooItem.expiration_date),

      department_id: odooItem.department_id ?? null,
      department_code: odooItem.department_code ?? null,
      department_name: odooItem.department_name ?? null,

      zone_id: odooItem.zone_id ?? null,
      zone_type: finalZoneType,

      unit: odooItem.unit ?? null,
      tracking: odooItem.tracking ?? null,
      user_manaul_url: odooItem.user_manaul_url ?? null,

      active: odooItem.active !== false,

      product_last_modified_date:
        toDateOrNull(odooItem.product_last_modified_date) ?? new Date(),
      lot_last_modified_date: toDateOrNull(odooItem.lot_last_modified_date),

      ...(groupInput !== undefined ? { input_number: groupInput } : {}),
    };

    const existingRows = await prisma.wms_mdt_goods.findMany({
      where: whereKey,
      orderBy: { id: "asc" },
    });

    if (existingRows.length === 0) {
      await prisma.wms_mdt_goods.create({ data: dataToSave });
      result.created++;
      logger.info(
        `➕ Created goods product_id=${odooItem.product_id} key=${JSON.stringify(whereKey)}`,
      );
    } else {
      await prisma.wms_mdt_goods.update({
        where: { id: existingRows[0].id },
        data: dataToSave,
      });
      result.updated++;
      logger.info(
        `🔄 Updated goods product_id=${odooItem.product_id} id=${existingRows[0].id}`,
      );

      if (existingRows.length > 1) {
        logger.warn(
          `⚠️ Duplicate goods rows detected (count=${existingRows.length}) key=${JSON.stringify(whereKey)}. Syncing all duplicates to same values.`,
        );
        await prisma.wms_mdt_goods.updateMany({
          where: whereKey,
          data: dataToSave,
        });
      }
    }

    // ✅ จำค่า zone_type ของ SKU นี้ไว้สำหรับ item ถัดไปใน batch เดียวกัน
    if (sku && finalZoneType) {
      zoneTypeBySku.set(sku, finalZoneType);
    }
  }
}

export const goodsSyncService = new GoodsSyncService();