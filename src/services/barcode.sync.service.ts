import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

interface BarcodeSyncResult {
  total_processed: number;
  created: number;
  updated: number;
  disabled: number;
  errors: string[];
}

class BarcodeSyncService {
  async syncBarcodes(barcodes: any[], triggeredBy: string = "manual"): Promise<BarcodeSyncResult> {
    const result: BarcodeSyncResult = {
      total_processed: barcodes.length,
      created: 0,
      updated: 0,
      disabled: 0,
      errors: [],
    };

    const startedAt = new Date();

    logger.info("🔄 Starting barcode sync from Odoo...", { triggeredBy, recordCount: barcodes.length });

    try {
      logger.info(`📦 Processing ${barcodes.length} barcodes...`);
      
      // Debug: แสดง sample ของ barcode 3 ตัวแรก
      if (barcodes.length > 0) {
        logger.info('📝 Sample barcodes from Odoo:', JSON.stringify(barcodes.slice(0, 3), null, 2));
      }
      
      for (const item of barcodes) {
        try {
          // ใช้ barcode text เป็นหลักในการเช็คว่ามีอยู่แล้วหรือไม่
          const existing = await prisma.barcode.findFirst({
            where: { 
              barcode: item.barcode,
            },
          });

          if (existing) {
            // Update existing barcode
            await prisma.barcode.update({
              where: { id: existing.id },
              data: {
                barcode: item.barcode,
                product_id: item.product_id,
                product_code: item.product_code || item.code,
                product_name: item.product_name || item.name,
                tracking: item.tracking,
                ratio: item.ratio,
                lot_start: item.lot_start,
                lot_stop: item.lot_stop,
                exp_start: item.exp_start,
                exp_stop: item.exp_stop,
                barcode_length: item.barcode_length,
                active: item.active !== false,
                barcode_last_modified_date: new Date(),
                updated_at: new Date(),
              },
            });
            result.updated++;
            logger.info(`🔄 Updated barcode: ${item.barcode} (barcode_id: ${item.barcode_id}, product: ${item.product_code})`);

          } else {
            // Create new barcode
            // หา wms_goods_id จาก product_id
            let wmsGoodsId: number | null = null;
            if (item.product_id) {
              const wmsGoods = await prisma.wms_mdt_goods.findFirst({
                where: { product_id: item.product_id },
              });
              wmsGoodsId = wmsGoods?.id || null;
            }

            await prisma.barcode.create({
              data: {
                barcode_id: item.barcode_id || item.id,
                barcode: item.barcode,
                product_id: item.product_id,
                wms_goods_id: wmsGoodsId,
                product_code: item.product_code || item.code,
                product_name: item.product_name || item.name,
                tracking: item.tracking,
                ratio: item.ratio,
                lot_start: item.lot_start,
                lot_stop: item.lot_stop,
                exp_start: item.exp_start,
                exp_stop: item.exp_stop,
                barcode_length: item.barcode_length,
                active: item.active !== false,
                barcode_last_modified_date: new Date(),
              },
            });
            result.created++;
            logger.info(`➕ Created barcode: ${item.barcode} (barcode_id: ${item.barcode_id}, product: ${item.product_code})`);
          }
        } catch (error: any) {
          const errorMsg = `Barcode ID ${item.barcode_id || item.id}: ${error.message}`;
          result.errors.push(errorMsg);
          logger.error(`❌ ${errorMsg}`);
        }
      }

      const duration = new Date().getTime() - startedAt.getTime();
      const status = result.errors.length > 0 ? "⚠️ PARTIAL SUCCESS" : "✅ SUCCESS";
      logger.info(`${status} Barcode sync completed in ${duration}ms`);
      logger.info(`📊 Summary: Created=${result.created}, Updated=${result.updated}, Disabled=${result.disabled}, Errors=${result.errors.length}`);

      // Log sync to odoo_sync_log
      await prisma.odoo_sync_log.create({
        data: {
          entity_type: "barcodes",
          sync_type: triggeredBy === "system" ? "scheduled" : "manual",
          status: "done",
          started_at: startedAt,
          completed_at: new Date(),
          records_fetched: result.total_processed,
          records_created: result.created,
          records_updated: result.updated,
          records_disabled: result.disabled,
          error_message: result.errors.length > 0 ? result.errors.join("; ") : null,
          triggered_by: triggeredBy,
        },
      });

      return result;
    } catch (error: any) {
      logger.error("❌ FAILED Barcode sync error:", error);
      // Log failed sync
      const stackTrace = error.stack || undefined;
      await prisma.odoo_sync_log.create({
        data: {
          entity_type: "barcodes",
          sync_type: triggeredBy === "system" ? "scheduled" : "manual",
          status: "error",
          started_at: startedAt,
          completed_at: new Date(),
          error_message: stackTrace ? `${error.message}\n\nStack trace:\n${stackTrace}` : error.message,
          triggered_by: triggeredBy,
        },
      });

      throw error;
    }
  }
}

export const barcodeSyncService = new BarcodeSyncService();
