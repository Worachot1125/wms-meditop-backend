import { prisma } from "../lib/prisma";
import { odooDbService } from "./odoo.db.service";
import { logger } from "../lib/logger";

interface StockSyncResult {
  success: boolean;
  snapshot_date: string;
  total_synced: number;
  errors: string[];
}

interface WmsStockSnapshotResult {
  success: boolean;
  snapshot_date: string;
  total_snapshot: number;
  errors: string[];
}

export class StockSyncService {
  /**
   * Sync Odoo Stock Balance (หลังเที่ยงคืน)
   * จะ clear ข้อมูล stock ของวันนี้แล้ว insert ใหม่
   */
  async syncOdooStock(triggeredBy: string = "system"): Promise<StockSyncResult> {
    const result: StockSyncResult = {
      success: true,
      snapshot_date: "",
      total_synced: 0,
      errors: [],
    };

    logger.info("🔄 Starting Odoo stock sync...", { triggeredBy });

    try {
      // ใช้วันที่ปัจจุบัน (00:00:00)
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      result.snapshot_date = today.toISOString().split("T")[0];

      // ดึงข้อมูล stock จาก Odoo Database
      logger.info("📥 Fetching stock from Odoo database...");
      const odooStocks = await odooDbService.getStocks();
      logger.info(`✅ Fetched ${odooStocks.length} stock records from Odoo`);

      // Clear ข้อมูล stock balance ของวันนี้ (source = odoo)
      logger.info(`🗑️ Clearing existing Odoo stock for ${result.snapshot_date}...`);
      const deleted = await prisma.stock_balance.deleteMany({
        where: {
          snapshot_date: today,
          source: "odoo",
        },
      });
      logger.info(`🗑️ Deleted ${deleted.count} existing records`);

      // Insert ข้อมูลใหม่
      if (odooStocks.length > 0) {
        logger.info(`💾 Inserting ${odooStocks.length} new stock records...`);
        const stockBalances = odooStocks.map((stock: any) => ({
          snapshot_date: today,
          product_id: stock.product_id || 0,
          product_code: stock.product_code || stock.code || "",
          location_id: stock.location_id || null,
          location_path: stock.location_path || null,
          location_name: stock.location_name || null,
          lot_id: stock.lot_id || null,
          lot_name: stock.lot_name || stock.lot_serial || null,
          quantity: stock.quantity || 0,
          expiration_date: stock.expiration_date ? new Date(stock.expiration_date) : null,
          active: stock.active !== undefined ? stock.active : true,
          source: "odoo",
        }));

        await prisma.stock_balance.createMany({
          data: stockBalances,
        });

        result.total_synced = stockBalances.length;
        logger.info(`✅ Successfully synced ${result.total_synced} stock records`);
      }

      // บันทึก sync log
      await prisma.odoo_sync_log.create({
        data: {
          entity_type: "stock",
          sync_type: triggeredBy === "system" ? "scheduled" : "manual",
          status: "done",
          started_at: new Date(),
          completed_at: new Date(),
          records_fetched: odooStocks.length,
          records_created: result.total_synced,
          records_updated: 0,
          records_disabled: 0,
          triggered_by: triggeredBy,
        },
      });

      logger.info(`✅ Odoo stock sync completed successfully`);
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.success = false;
      result.errors.push(errorMsg);
      logger.error(`❌ Odoo stock sync failed: ${errorMsg}`);

      // บันทึก error log
      const stackTrace = error instanceof Error ? error.stack : undefined;
      await prisma.odoo_sync_log.create({
        data: {
          entity_type: "stock",
          sync_type: triggeredBy === "system" ? "scheduled" : "manual",
          status: "error",
          started_at: new Date(),
          completed_at: new Date(),
          records_fetched: 0,
          records_created: 0,
          records_updated: 0,
          records_disabled: 0,
          error_message: stackTrace ? `${errorMsg}\n\nStack trace:\n${stackTrace}` : errorMsg,
          triggered_by: triggeredBy,
        },
      });

      throw error;
    }
  }

  /**
   * สร้าง WMS Stock Snapshot (รันทุกสิ้นวัน)
   * จะ clear ข้อมูล stock snapshot ของ WMS วันนี้แล้ว insert ใหม่
   */
  async createWmsSnapshot(triggeredBy: string = "system"): Promise<WmsStockSnapshotResult> {
    const result: WmsStockSnapshotResult = {
      success: true,
      snapshot_date: "",
      total_snapshot: 0,
      errors: [],
    };

    logger.info("📸 Starting WMS stock snapshot...", { triggeredBy });

    try {
      // ใช้วันที่ปัจจุบัน (00:00:00)
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      result.snapshot_date = today.toISOString().split("T")[0];

      // Clear ข้อมูล stock balance ของวันนี้ (source = wms)
      logger.info(`🗑️ Clearing existing WMS snapshot for ${result.snapshot_date}...`);
      const deleted = await prisma.stock_balance.deleteMany({
        where: {
          snapshot_date: today,
          source: "wms",
        },
      });
      logger.info(`🗑️ Deleted ${deleted.count} existing snapshot records`);

      // ดึงข้อมูล stock ปัจจุบันจาก WMS
      logger.info("📥 Fetching current WMS stock...");
      const wmsStocks = await prisma.stock.findMany({
        where: {
          // Stock table ไม่มี deleted_at แล้ว
        },
      });
      logger.info(`✅ Found ${wmsStocks.length} active stock records in WMS`);

      // Insert snapshot
      if (wmsStocks.length > 0) {
        logger.info(`💾 Creating ${wmsStocks.length} snapshot records...`);
        const stockBalances = wmsStocks.map((stock) => ({
          snapshot_date: today,
          product_id: stock.product_id || 0,
          product_code: stock.product_code || "",
          location_id: stock.location_id || null,
          location_path: null,
          location_name: stock.location_name || null,
          lot_id: stock.lot_id || null,
          lot_name: stock.lot_name || null,
          quantity: stock.quantity,
          expiration_date: stock.expiration_date || null,
          source: "wms",
        }));

        await prisma.stock_balance.createMany({
          data: stockBalances,
          skipDuplicates: true,
        });

        result.total_snapshot = stockBalances.length;
        logger.info(`✅ Successfully created ${result.total_snapshot} snapshot records`);
      } else {
        logger.warn("⚠️ No active stock found in WMS");
      }

      logger.info(`✅ WMS stock snapshot completed successfully`);
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.success = false;
      result.errors.push(errorMsg);
      logger.error(`❌ WMS stock snapshot failed: ${errorMsg}`);
      throw error;
    }
  }
}

export const stockSyncService = new StockSyncService();
