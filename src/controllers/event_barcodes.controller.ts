import type { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest } from "../utils/appError";
import { EventBarcodesRequestBody } from "../types/event_barcodes";

/**
 * POST /api/EventBarcodes
 * รับ event barcodes จาก Odoo และทำการ sync ข้อมูล
 * รองรับ create, update, delete ในคำขอเดียว
 */
export const handleEventBarcodes = asyncHandler(
  async (req: Request<{}, {}, EventBarcodesRequestBody>, res: Response) => {
    let logId: number | null = null;

    try {
      // บันทึก request log
      const requestLog = await prisma.odoo_request_log.create({
        data: {
          endpoint: "/api/EventBarcodes",
          method: "POST",
          request_body: JSON.stringify(req.body),
          ip_address: req.ip || req.socket.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });

      logId = requestLog.id;

      // รองรับทั้ง { barcodes: [...] } และ { params: { barcodes: [...] } }
      const barcodes = 'params' in req.body && req.body.params
        ? (req.body.params as any).barcodes
        : 'barcodes' in req.body
        ? req.body.barcodes
        : null;

      // Validate request body
      if (!barcodes || !Array.isArray(barcodes)) {
        throw badRequest("Request body ต้องมี 'barcodes' เป็น array");
      }

      if (barcodes.length === 0) {
        throw badRequest("barcodes array ต้องมีข้อมูลอย่างน้อย 1 รายการ");
      }

      // Validate แต่ละ item
      for (const item of barcodes) {
        if (!item.barcode_id || !item.barcode) {
          throw badRequest(
            "แต่ละ barcode item ต้องมี barcode_id และ barcode"
          );
        }
        if (!item.event) {
          throw badRequest(
            "แต่ละ barcode item ต้องมี event (C/create, U/update, D/delete)"
          );
        }
      }

      // แยก barcodes ตาม event (รองรับทั้ง short form และ long form)
      const createItems = barcodes.filter((b: any) => 
        b.event === "C" || b.event === "create"
      );
      const updateItems = barcodes.filter((b: any) => 
        b.event === "U" || b.event === "update"
      );
      const deleteItems = barcodes.filter((b: any) => 
        b.event === "D" || b.event === "delete"
      );

      let createdCount = 0;
      let updatedCount = 0;
      let deletedCount = 0;
      const errors: string[] = [];

      // Process CREATE events
      for (const item of createItems) {
        try {
          const existing = await prisma.barcode.findFirst({
            where: { barcode_id: item.barcode_id },
          });

          if (existing) {
            errors.push(`Barcode ID ${item.barcode_id} มีอยู่ในระบบแล้ว (create skipped)`);
            continue;
          }

          // หา wms_goods_id จาก product_id (ถ้ามี)
          let wmsGoodsId: number | null = null;
          if (item.product_id) {
            const wmsGoods = await prisma.wms_mdt_goods.findFirst({
              where: { product_id: item.product_id },
            });
            wmsGoodsId = wmsGoods?.id || null;
          }

          await prisma.barcode.create({
            data: {
              barcode_id: item.barcode_id,
              barcode: item.barcode,
              product_id: item.product_id,
              wms_goods_id: wmsGoodsId,
              product_code: item.product_code,
              product_name: item.product_name,
              ratio: item.ratio,
              lot_start: item.lot_start,
              lot_stop: item.lot_stop,
              exp_start: item.exp_start,
              exp_stop: item.exp_stop,
              active: true,
              barcode_last_modified_date: new Date(),
            },
          });
          createdCount++;
        } catch (error: any) {
          errors.push(`Create Barcode ID ${item.barcode_id}: ${error.message}`);
        }
      }

      // Process UPDATE events
      for (const item of updateItems) {
        try {
          const existing = await prisma.barcode.findFirst({
            where: { barcode_id: item.barcode_id },
          });

          if (!existing) {
            errors.push(`Barcode ID ${item.barcode_id} ไม่พบในระบบ (update skipped)`);
            continue;
          }

          // หา wms_goods_id จาก product_id (ถ้ามี)
          let wmsGoodsId: number | null | undefined = undefined;
          if (item.product_id !== undefined) {
            const wmsGoods = await prisma.wms_mdt_goods.findFirst({
              where: { product_id: item.product_id },
            });
            wmsGoodsId = wmsGoods?.id || null;
          }

          const updateData: any = {
            barcode_last_modified_date: new Date(),
          };

          // Update เฉพาะ field ที่ส่งมา
          if (item.barcode !== undefined) updateData.barcode = item.barcode;
          if (item.product_id !== undefined) updateData.product_id = item.product_id;
          if (wmsGoodsId !== undefined) updateData.wms_goods_id = wmsGoodsId;
          if (item.product_code !== undefined) updateData.product_code = item.product_code;
          if (item.product_name !== undefined) updateData.product_name = item.product_name;
          if (item.ratio !== undefined) updateData.ratio = item.ratio;
          if (item.lot_start !== undefined) updateData.lot_start = item.lot_start;
          if (item.lot_stop !== undefined) updateData.lot_stop = item.lot_stop;
          if (item.exp_start !== undefined) updateData.exp_start = item.exp_start;
          if (item.exp_stop !== undefined) updateData.exp_stop = item.exp_stop;

          await prisma.barcode.update({
            where: { id: existing.id },
            data: updateData,
          });
          updatedCount++;
        } catch (error: any) {
          errors.push(`Update Barcode ID ${item.barcode_id}: ${error.message}`);
        }
      }

      // Process DELETE events
      for (const item of deleteItems) {
        try {
          const existing = await prisma.barcode.findFirst({
            where: { barcode_id: item.barcode_id },
          });

          if (!existing) {
            errors.push(`Barcode ID ${item.barcode_id} ไม่พบในระบบ (delete skipped)`);
            continue;
          }

          await prisma.barcode.update({
            where: { id: existing.id },
            data: {
              active: false,
              barcode_last_modified_date: new Date(),
            },
          });
          deletedCount++;
        } catch (error: any) {
          errors.push(`Delete Barcode ID ${item.barcode_id}: ${error.message}`);
        }
      }

      const responseBody = {
        success: true,
        message: `ประมวลผล barcodes สำเร็จ`,
        result: {
          total_processed: barcodes.length,
          created: createdCount,
          updated: updatedCount,
          deleted: deletedCount,
          errors: errors.length > 0 ? errors : undefined,
        },
      };

      // บันทึก odoo_sync_log
      await prisma.odoo_sync_log.create({
        data: {
          entity_type: "barcodes",
          sync_type: "manual",
          status: "done",
          completed_at: new Date(),
          records_fetched: barcodes.length,
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
