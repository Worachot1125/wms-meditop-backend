import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest } from "../utils/appError";
import { EventGoodsRequestBody } from "../types/event_goods";
import { goodsSyncService } from "../services/goods.sync.service";
import { odooDbService } from "../services/odoo.db.service";

function extractZone(item: any): {
  zone_id?: number | null;
  zone_type?: string | null;
} {
  const zones = Array.isArray(item?.zones) ? item.zones : [];
  const z0 = zones.length > 0 ? zones[0] : null;

  const zone_id =
    z0?.zone_id !== undefined && z0?.zone_id !== null
      ? Number(z0.zone_id)
      : item.zone_id !== undefined && item.zone_id !== null
        ? Number(item.zone_id)
        : null;

  const zone_type =
    z0?.zone !== undefined && z0?.zone !== null
      ? String(z0.zone).trim() || null
      : item.zone !== undefined && item.zone !== null
        ? String(item.zone).trim() || null
        : null;

  return { zone_id, zone_type };
}

/**
 * POST /api/EventGoods
 * รับ event goods จาก Odoo และทำการ sync ข้อมูล
 */
export const handleEventGoods = asyncHandler(
  async (req: Request<{}, {}, EventGoodsRequestBody>, res: Response) => {
    let logId: number | null = null;

    try {
      // บันทึก request log
      const requestLog = await prisma.odoo_request_log.create({
        data: {
          endpoint: "/api/EventGoods",
          method: "POST",
          request_body: JSON.stringify(req.body),
          ip_address: req.ip || req.socket.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });

      logId = requestLog.id;

      // รองรับทั้ง { goods: [...] } และ { params: { goods: [...] } }
      const goods =
        "params" in req.body && req.body.params
          ? (req.body.params as any).goods
          : "goods" in req.body
            ? req.body.goods
            : null;

      // Validate request body
      if (!goods || !Array.isArray(goods)) {
        throw badRequest("Request body ต้องมี 'goods' เป็น array");
      }

      if (goods.length === 0) {
        throw badRequest("goods array ต้องมีข้อมูลอย่างน้อย 1 รายการ");
      }

      // Validate แต่ละ item
      for (const item of goods) {
        if (!item.product_id || !item.name) {
          throw badRequest("แต่ละ goods item ต้องมี product_id และ name");
        }
        if (!item.event) {
          throw badRequest(
            "แต่ละ goods item ต้องมี event (C/create, U/update, D/delete)",
          );
        }
      }

      // แยก goods ตาม event (รองรับทั้ง short form และ long form)
      const createItems = goods.filter(
        (g: any) => g.event === "C" || g.event === "create",
      );
      const updateItems = goods.filter(
        (g: any) => g.event === "U" || g.event === "update",
      );
      const deleteItems = goods.filter(
        (g: any) => g.event === "D" || g.event === "delete",
      );

      let createdCount = 0;
      let updatedCount = 0;
      let deletedCount = 0;
      const errors: string[] = [];

      // Process CREATE events
      for (const item of createItems) {
        try {
          const existing = await prisma.wms_mdt_goods.findFirst({
            where: { product_id: item.product_id },
          });

          if (existing) {
            errors.push(
              `Product ID ${item.product_id} มีอยู่ในระบบแล้ว (create skipped)`,
            );
            continue;
          }

          // Extract zone_id และ zone จาก zones array (ใช้ตัวแรก)
          const zoneId =
            Array.isArray((item as any).zones) &&
            (item as any).zones.length > 0 &&
            (item as any).zones[0].zone_id
              ? (item as any).zones[0].zone_id
              : item.zone_id;
          const zoneType =
            Array.isArray((item as any).zones) &&
            (item as any).zones.length > 0 &&
            (item as any).zones[0].zone
              ? (item as any).zones[0].zone
              : item.zone;

          await prisma.wms_mdt_goods.create({
            data: {
              product_id: item.product_id,
              product_code: item.code,
              product_name: item.name,
              product_type: item.type,
              tracking: item.tracking,
              department_id: item.department_id,
              department_name: item.department,
              zone_id: zoneId,
              zone_type: zoneType,
              unit: item.unit,
              active: item.active !== false,
              input_number: (item as any).input_number ?? false,
              product_last_modified_date: new Date(),
            },
          });
          createdCount++;
        } catch (error: any) {
          errors.push(`Create Product ID ${item.product_id}: ${error.message}`);
        }
      }

      // Process UPDATE events
      // Process UPDATE events  ✅ update ทั้งกลุ่ม SKU
      for (const item of updateItems) {
        try {
          const sku = String(item.code ?? "").trim();
          if (!sku) {
            errors.push(
              `Update Product ID ${item.product_id}: missing code (SKU)`,
            );
            continue;
          }

          // หาเพื่อเช็คว่ามี sku นี้ในระบบจริงไหม (ไม่จำเป็นต้องใช้ product_id แล้ว)
          const anyRow = await prisma.wms_mdt_goods.findFirst({
            where: { product_code: sku },
            select: { id: true },
          });

          if (!anyRow) {
            errors.push(`SKU ${sku} ไม่พบในระบบ (update skipped)`);
            continue;
          }

          const { zone_id, zone_type } = extractZone(item);

          const updateData: any = {
            product_last_modified_date: new Date(),
          };

          // ✅ อัปเดต field ตามที่ส่งมา (เหมือนเดิม)
          if (item.code !== undefined)
            updateData.product_code = String(item.code).trim();
          if (item.name !== undefined) updateData.product_name = item.name;
          if (item.type !== undefined) updateData.product_type = item.type;
          if (item.tracking !== undefined) updateData.tracking = item.tracking;

          if (item.department_id !== undefined)
            updateData.department_id = item.department_id;
          if (item.department !== undefined)
            updateData.department_name = item.department;

          // ✅ zones -> อัปเดตทั้งกลุ่ม
          if (zone_id !== undefined) updateData.zone_id = zone_id;
          if (zone_type !== undefined) updateData.zone_type = zone_type;

          if (item.unit !== undefined) updateData.unit = item.unit;
          if (item.active !== undefined) updateData.active = item.active;
          if ((item as any).input_number !== undefined)
            updateData.input_number = (item as any).input_number;

          // ✅ จุดสำคัญ: updateMany ด้วย product_code (ทั้งกลุ่ม SKU)
          const r = await prisma.wms_mdt_goods.updateMany({
            where: { product_code: sku },
            data: updateData,
          });

          updatedCount += r.count; // จะนับเป็นจำนวนแถวที่โดนอัปเดต
        } catch (error: any) {
          errors.push(`Update Product ID ${item.product_id}: ${error.message}`);
        }
      }

      // Process DELETE events
      // Process DELETE events ✅ ปิดทั้งกลุ่ม SKU
      for (const item of deleteItems) {
        try {
          const sku = String(item.code ?? "").trim();
          if (!sku) {
            errors.push(
              `Delete Product ID ${item.product_id}: missing code (SKU)`,
            );
            continue;
          }

          const r = await prisma.wms_mdt_goods.updateMany({
            where: { product_code: sku },
            data: {
              active: false,
              product_last_modified_date: new Date(),
            },
          });

          if (r.count === 0) {
            errors.push(`SKU ${sku} ไม่พบในระบบ (delete skipped)`);
            continue;
          }

          deletedCount += r.count;
        } catch (error: any) {
          errors.push(`Delete Product ID ${item.product_id}: ${error.message}`);
        }
      }

      const responseBody = {
        success: true,
        message: `ประมวลผล goods สำเร็จ`,
        result: {
          total_processed: goods.length,
          created: createdCount,
          updated: updatedCount,
          deleted: deletedCount,
          errors: errors.length > 0 ? errors : undefined,
        },
      };

      // บันทึก odoo_sync_log
      await prisma.odoo_sync_log.create({
        data: {
          entity_type: "goods",
          sync_type: "manual",
          status: "done",
          completed_at: new Date(),
          records_fetched: goods.length,
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
  },
);

/**
 * POST /api/goods/sync
 * Manual sync goods (สำหรับ admin ใช้งาน)
 */
export const manualSyncGoods = asyncHandler(
  async (req: Request, res: Response) => {
    let logId: number | null = null;

    try {
      const requestLog = await prisma.odoo_request_log.create({
        data: {
          endpoint: "/api/goods/sync",
          method: "POST",
          request_body: JSON.stringify(req.body ?? {}), // กันพัง
          ip_address: req.ip || req.socket.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });
      logId = requestLog.id;

      // ดึงจาก Odoo DB
      const rows = await odooDbService.getGoods();

      // trigger user
      const userId = (req as any).user?.id || "manual";

      // ส่ง rows เข้า service ตรง ๆ (ให้ normalizeGoods จัดการเอง)
      const result = await goodsSyncService.syncGoods(
        rows as any[],
        String(userId),
      );

      const responseBody = {
        success: true,
        message: "Sync goods เรียบร้อย",
        result,
      };

      await prisma.odoo_request_log.update({
        where: { id: logId },
        data: {
          response_status: 200,
          response_body: JSON.stringify(responseBody),
        },
      });

      return res.status(200).json(responseBody);
    } catch (error: any) {
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
  },
);
