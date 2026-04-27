import cron from "node-cron";
import { departmentSyncService } from "../services/department.sync.service";
import { goodsSyncService } from "../services/goods.sync.service";
import { barcodeSyncService } from "../services/barcode.sync.service";
import { zoneTypeSyncService } from "../services/zone_type.sync.service";
import { stockSyncService } from "../services/stock.sync.service";
import { odooDbService } from "../services/odoo.db.service";
import { wmsDailySnapshotService } from "../services/stockdaily.snapshot.service";
import { logger } from "../lib/logger";

const TZ = "Asia/Bangkok";
/**
 * Scheduler for automatic Odoo sync
 * 
 * Runs all master data sync every day at 23:59 (11:59 PM)
 * - Departments (wms.wms_mdt_department)
 * - Goods/SKU (wms.wms_mdt_goods)
 * - Barcodes (wms.wms_mdt_barcode)
 * - Zone Types (wms.wms_mdt_zone_type)
 * 
 * Runs stock sync at 00:01 (12:01 AM) - หลังเที่ยงคืน
 * - Odoo Stock Balance
 * - WMS Stock Snapshot
 */
export function initializeScheduler() {
  // ✅ Master data sync - 23:59
  cron.schedule(
    "59 23 * * *",
    async () => {
      logger.info("Starting scheduled master data sync from Odoo...");

      try {
        logger.info("Syncing departments...");
        const deptResult = await departmentSyncService.syncDepartments("system");
        logger.info(
          `Department sync: Fetched=${deptResult.recordsFetched}, ` +
            `Created=${deptResult.recordsCreated}, Updated=${deptResult.recordsUpdated}, ` +
            `Disabled=${deptResult.recordsDisabled}`,
        );

        logger.info("Syncing goods/SKU...");
        const odooGoods = await odooDbService.getGoods();
        const goodsResult = await goodsSyncService.syncGoods(
          odooGoods.map((item) => ({ ...item, event: "sync" })),
          "system",
        );
        logger.info(
          `Goods sync: Processed=${goodsResult.total_processed}, ` +
            `Created=${goodsResult.created}, Updated=${goodsResult.updated}, ` +
            `Disabled=${goodsResult.disabled}`,
        );

        logger.info("Syncing barcodes...");
        const odooBarcodes = await odooDbService.getBarcodes();
        const barcodeResult = await barcodeSyncService.syncBarcodes(odooBarcodes, "system");
        logger.info(
          `Barcode sync: Processed=${barcodeResult.total_processed}, ` +
            `Created=${barcodeResult.created}, Updated=${barcodeResult.updated}`,
        );

        logger.info("Syncing zone types...");
        const odooZoneTypes = await odooDbService.getZoneTypes();
        const zoneTypeResult = await zoneTypeSyncService.syncZoneTypes(odooZoneTypes, "system");
        logger.info(
          `Zone Type sync: Processed=${zoneTypeResult.total_processed}, ` +
            `Created=${zoneTypeResult.created}, Updated=${zoneTypeResult.updated}`,
        );

        logger.info("✅ Scheduled master data sync completed successfully.");
      } catch (error) {
        logger.error("❌ Scheduled master data sync failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    { timezone: TZ },
  );

  // ✅ Stock sync - 00:01
  cron.schedule(
    "1 0 * * *",
    async () => {
      logger.info("Starting scheduled stock sync (post-midnight)...");

      try {
        logger.info("Syncing Odoo stock balance...");
        const odooStockResult = await stockSyncService.syncOdooStock("system");
        logger.info(
          `Odoo Stock sync: Date=${odooStockResult.snapshot_date}, Synced=${odooStockResult.total_synced}`,
        );

        logger.info("Creating WMS stock snapshot...");
        const wmsSnapshotResult = await stockSyncService.createWmsSnapshot("system");
        logger.info(
          `WMS Snapshot: Date=${wmsSnapshotResult.snapshot_date}, Snapshot=${wmsSnapshotResult.total_snapshot}`,
        );

        logger.info("✅ Scheduled stock sync completed successfully.");
      } catch (error) {
        logger.error("❌ Scheduled stock sync failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    { timezone: TZ },
  );

  // ✅ Daily report snapshot (stocks -> wms_stock_daily) - 00:03
  cron.schedule(
    "3 0 * * *",
    async () => {
      logger.info("Starting scheduled WMS DAILY report snapshot (stocks -> wms_stock_daily)...");

      try {
        const dailyResult = await wmsDailySnapshotService.createDailySnapshot("cron");
        logger.info(
          `✅ WMS DAILY snapshot: Date=${dailyResult.snapshot_date}, Total=${dailyResult.total_snapshot}`,
        );
      } catch (error) {
        logger.error("❌ WMS DAILY snapshot failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    { timezone: TZ },
  );

  logger.info("Odoo sync scheduler initialized:");
  logger.info(`- Timezone: ${TZ}`);
  logger.info("- Master data sync will run daily at 23:59");
  logger.info("- Stock sync will run daily at 00:01 (post-midnight)");
  logger.info("- WMS DAILY report snapshot will run daily at 00:03 (stocks -> wms_stock_daily)");
}