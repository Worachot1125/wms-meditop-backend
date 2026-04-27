import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

interface ZoneTypeSyncResult {
  total_processed: number;
  created: number;
  updated: number;
  disabled: number;
  errors: string[];
}

class ZoneTypeSyncService {
  async syncZoneTypes(zoneTypes: any[], triggeredBy: string = "manual"): Promise<ZoneTypeSyncResult> {
    const result: ZoneTypeSyncResult = {
      total_processed: zoneTypes.length,
      created: 0,
      updated: 0,
      disabled: 0,
      errors: [],
    };

    const startedAt = new Date();

    logger.info("🔄 Starting zone_type sync from Odoo...", { triggeredBy, recordCount: zoneTypes.length });

    try {
      logger.info(`📦 Processing ${zoneTypes.length} zone types...`);
      for (const item of zoneTypes) {
        try {
          const existing = await prisma.zone_type.findFirst({
            where: { station_id: item.station_id || item.id },
          });

          if (existing) {
            // Update existing zone_type
            await prisma.zone_type.update({
              where: { id: existing.id },
              data: {
                station_name: item.station_name || item.name,
                full_name: item.description, // description ไปที่ full_name
                short_name: item.station_name || item.name, // station_name จาก Odoo ไปที่ short_name
                remark: item.notes, // notes ไปที่ remark
                sequence: item.sequence,
                temp_min: item.temp_min,
                temp_max: item.temp_max,
                humidity_min: item.humidity_min,
                humidity_max: item.humidity_max,
                updated_at: new Date(),
              },
            });
            result.updated++;
            logger.info(`🔄 Updated zone_type: ${item.station_name} (station_id: ${item.station_id})`);
          } else {
            // Create new zone_type (ID will auto-increment)
            // zone_type_code ขึ้นมาเอง โดยนับจำนวน zone_type ที่มีอยู่ + 1 เป็น 01, 02, 03, ...
            let zoneTypeCode: string | null = null;
            try {
              const count = await prisma.zone_type.count();
              zoneTypeCode = String(count + 1).padStart(2, '0');
            } catch (error) {
              // ถ้านับไม่ได้ ให้ใส่ null
              logger.warn(`Cannot generate zone_type_code, setting to null`);
              zoneTypeCode = null;
            }

            const created = await prisma.zone_type.create({
              data: {
                zone_type_code: zoneTypeCode,
                station_id: item.station_id || item.id,
                station_name: item.station_name || item.name || `Station ${item.station_id || item.id}`,
                full_name: item.description, // description ไปที่ full_name
                short_name: item.station_name || item.name, // station_name จาก Odoo ไปที่ short_name
                remark: item.notes, // notes ไปที่ remark
                sequence: item.sequence,
                temp_min: item.temp_min,
                temp_max: item.temp_max,
                humidity_min: item.humidity_min,
                humidity_max: item.humidity_max,
              },
            });
            result.created++;
            logger.info(`➕ Created zone_type: ${item.station_name} (station_id: ${item.station_id}, zone_type_code: ${zoneTypeCode}, ID: ${created.id})`);
          }
        } catch (error: any) {
          const errorMsg = `Station ID ${item.station_id || item.id}: ${error.message}`;
          result.errors.push(errorMsg);
          logger.error(`❌ ${errorMsg}`);
        }
      }

      const duration = new Date().getTime() - startedAt.getTime();
      const status = result.errors.length > 0 ? "⚠️ PARTIAL SUCCESS" : "✅ SUCCESS";
      logger.info(`${status} Zone_type sync completed in ${duration}ms`);
      logger.info(`📊 Summary: Created=${result.created}, Updated=${result.updated}, Disabled=${result.disabled}, Errors=${result.errors.length}`);

      // Log sync to odoo_sync_log
      await prisma.odoo_sync_log.create({
        data: {
          entity_type: "zone_type",
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
      logger.error("❌ FAILED Zone_type sync error:", error);
      // Log failed sync
      const stackTrace = error.stack || undefined;
      await prisma.odoo_sync_log.create({
        data: {
          entity_type: "zone_type",
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

export const zoneTypeSyncService = new ZoneTypeSyncService();
