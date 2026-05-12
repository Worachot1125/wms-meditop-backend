// src/services/wmsDailySnapshot.service.ts

import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

export interface WmsDailySnapshotResult {
  success: boolean;
  snapshot_date: string;
  total_snapshot: number;
  errors: string[];
}

function toStartOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

export class WmsDailySnapshotService {
  /**
   * Refresh daily WMS stock snapshot.
   *
   * Policy:
   * - Keep old dates.
   * - Delete only the target date.
   * - Insert latest live WMS stock again.
   * - Can run every hour safely.
   */
  async createDailySnapshot(
    triggeredBy: string = "system",
    date?: string,
  ): Promise<WmsDailySnapshotResult> {
    const result: WmsDailySnapshotResult = {
      success: true,
      snapshot_date: "",
      total_snapshot: 0,
      errors: [],
    };

    try {
      const target = date
        ? toStartOfDay(new Date(date))
        : toStartOfDay(new Date());

      const nextDay = addDays(target, 1);
      result.snapshot_date = target.toISOString().split("T")[0];

      logger.info("📸 Refreshing WMS daily latest snapshot...", {
        triggeredBy,
        snapshot_date: result.snapshot_date,
      });

      const liveStocks = await prisma.stock.findMany({
        where: {
          source: "wms",
        },
        orderBy: {
          id: "asc",
        },
      });

      logger.info(`📥 Found ${liveStocks.length} live WMS stock records`);

      await prisma.$transaction(async (tx) => {
        const deleted = await tx.wms_stock_daily.deleteMany({
          where: {
            snapshot_date: {
              gte: target,
              lt: nextDay,
            },
          },
        });

        logger.info(
          `🗑️ Deleted ${deleted.count} existing records for ${result.snapshot_date}`,
        );

        if (liveStocks.length === 0) return;

        await tx.wms_stock_daily.createMany({
          data: liveStocks.map((s) => ({
            snapshot_date: target,

            bucket_key: s.bucket_key,

            product_id: s.product_id,
            product_code: s.product_code ?? null,
            product_name: s.product_name ?? null,
            unit: s.unit ?? null,

            location_id: s.location_id ?? null,
            location_name: s.location_name ?? null,

            lot_id: s.lot_id ?? null,
            lot_name: s.lot_name ?? null,
            expiration_date: s.expiration_date ?? null,

            quantity: s.quantity,
          })),
        });
      });

      result.total_snapshot = await prisma.wms_stock_daily.count({
        where: {
          snapshot_date: {
            gte: target,
            lt: nextDay,
          },
        },
      });

      logger.info(
        `✅ WMS daily latest snapshot done: ${result.total_snapshot} rows`,
      );

      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);

      result.success = false;
      result.errors.push(msg);

      logger.error(`❌ WMS daily latest snapshot failed: ${msg}`);
      throw e;
    }
  }
}

export const wmsDailySnapshotService = new WmsDailySnapshotService();