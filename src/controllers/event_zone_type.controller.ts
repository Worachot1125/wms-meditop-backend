import type { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest } from "../utils/appError";
import { EventZoneTypeRequestBody } from "../types/event_zone_type";

/**
 * POST /api/EventZoneType
 * รับ event zone_types จาก Odoo และทำการ sync ข้อมูล
 * รองรับ create, update, delete ในคำขอเดียว
 */
export const handleEventZoneType = asyncHandler(
  async (req: Request<{}, {}, EventZoneTypeRequestBody>, res: Response) => {
    let logId: number | null = null;

    try {
      // บันทึก request log
      const requestLog = await prisma.odoo_request_log.create({
        data: {
          endpoint: "/api/EventZoneType",
          method: "POST",
          request_body: JSON.stringify(req.body),
          ip_address: req.ip || req.socket.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });

      logId = requestLog.id;

      // รองรับทั้ง { zone_types: [...] } และ { params: { zone_types: [...] } }
      const zone_types = 'params' in req.body && req.body.params
        ? (req.body.params as any).zone_types
        : 'zone_types' in req.body
        ? req.body.zone_types
        : null;

      // Validate request body
      if (!zone_types || !Array.isArray(zone_types)) {
        throw badRequest("Request body ต้องมี 'zone_types' เป็น array");
      }

      if (zone_types.length === 0) {
        throw badRequest("zone_types array ต้องมีข้อมูลอย่างน้อย 1 รายการ");
      }

      // Validate แต่ละ item
      for (const item of zone_types) {
        if (!item.station_id) {
          throw badRequest("แต่ละ zone_type item ต้องมี station_id");
        }
        if (!item.event) {
          throw badRequest(
            "แต่ละ zone_type item ต้องมี event (C/create, U/update, D/delete)"
          );
        }
      }

      // แยก zone_types ตาม event (รองรับทั้ง short form และ long form)
      const createItems = zone_types.filter((z: any) => 
        z.event === "C" || z.event === "create"
      );
      const updateItems = zone_types.filter((z: any) => 
        z.event === "U" || z.event === "update"
      );
      const deleteItems = zone_types.filter((z: any) => 
        z.event === "D" || z.event === "delete"
      );

      let createdCount = 0;
      let updatedCount = 0;
      let deletedCount = 0;
      const errors: string[] = [];

      // Process CREATE events
      for (const item of createItems) {
        try {
          const existing = await prisma.zone_type.findFirst({
            where: { station_id: item.station_id },
          });

          if (existing) {
            errors.push(`Station ID ${item.station_id} มีอยู่ในระบบแล้ว (create skipped)`);
            continue;
          }

          // สร้าง id ใหม่ (ใช้ station_id หรือ station_name)
          const newId = item.station_name 
            ? item.station_name.substring(0, 50).replace(/\s+/g, '_')
            : `station_${item.station_id}`;

          await prisma.zone_type.create({
            data: {
              id: newId,
              station_id: item.station_id,
              station_name: item.station_name || `Station ${item.station_id}`,
              full_name: item.station_name || `Station ${item.station_id}`,
              short_name: item.station_name?.substring(0, 20) || `S${item.station_id}`,
              sequence: item.sequence,
              description: item.description,
              notes: item.notes,
              temp_min: item.temp_min,
              temp_max: item.temp_max,
              humidity_min: item.humidity_min,
              humidity_max: item.humidity_max,
            },
          });
          createdCount++;
        } catch (error: any) {
          errors.push(`Create Station ID ${item.station_id}: ${error.message}`);
        }
      }

      // Process UPDATE events
      for (const item of updateItems) {
        try {
          const existing = await prisma.zone_type.findFirst({
            where: { station_id: item.station_id },
          });

          if (!existing) {
            errors.push(`Station ID ${item.station_id} ไม่พบในระบบ (update skipped)`);
            continue;
          }

          await prisma.zone_type.update({
            where: { id: existing.id },
            data: {
              station_name: item.station_name ?? undefined,
              full_name: item.station_name ?? undefined,
              short_name: item.station_name?.substring(0, 20) ?? undefined,
              sequence: item.sequence ?? undefined,
              description: item.description ?? undefined,
              notes: item.notes ?? undefined,
              temp_min: item.temp_min ?? undefined,
              temp_max: item.temp_max ?? undefined,
              humidity_min: item.humidity_min ?? undefined,
              humidity_max: item.humidity_max ?? undefined,
              updated_at: new Date(),
            },
          });
          updatedCount++;
        } catch (error: any) {
          errors.push(`Update Station ID ${item.station_id}: ${error.message}`);
        }
      }

      // Process DELETE events
      for (const item of deleteItems) {
        try {
          const existing = await prisma.zone_type.findFirst({
            where: { station_id: item.station_id },
          });

          if (!existing) {
            errors.push(`Station ID ${item.station_id} ไม่พบในระบบ (delete skipped)`);
            continue;
          }

          await prisma.zone_type.update({
            where: { id: existing.id },
            data: {
              deleted_at: new Date(),
              updated_at: new Date(),
            },
          });
          deletedCount++;
        } catch (error: any) {
          errors.push(`Delete Station ID ${item.station_id}: ${error.message}`);
        }
      }

      const responseBody = {
        success: true,
        message: `ประมวลผล zone_types สำเร็จ`,
        result: {
          total_processed: zone_types.length,
          created: createdCount,
          updated: updatedCount,
          deleted: deletedCount,
          errors: errors.length > 0 ? errors : undefined,
        },
      };

      // บันทึก odoo_sync_log
      await prisma.odoo_sync_log.create({
        data: {
          entity_type: "zone_type",
          sync_type: "manual",
          status: "done",
          completed_at: new Date(),
          records_fetched: zone_types.length,
          records_created: createdCount,
          records_updated: updatedCount,
          records_disabled: deletedCount,
          error_message: errors.length > 0 ? errors.join("; ") : null,
          triggered_by: "odoo_webhook",
        },
      });

      // อัพเดต log ด้วย response
      if (logId) {
        await prisma.odoo_request_log.update({
          where: { id: logId },
          data: {
            response_status: 200,
            response_body: JSON.stringify(responseBody),
          },
        });
      }

      return res.status(200).json(responseBody);
    } catch (error: any) {
      // บันทึก error ใน log
      if (logId) {
        await prisma.odoo_request_log.update({
          where: { id: logId },
          data: {
            response_status: error.statusCode || 500,
            error_message: error.message,
          },
        });
      }

      throw error;
    }
  }
);
