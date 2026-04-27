import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest } from "../utils/appError";
import { EventGoodsRequestBody } from "../types/event_goods";

/**
 * POST /api/EventGoods/Create
 * สร้าง goods ใหม่จาก Odoo
 */
export const createEventGoods = asyncHandler(
  async (req: Request<{}, {}, EventGoodsRequestBody>, res: Response) => {
    let logId: number | null = null;

    try {
      const requestLog = await prisma.odoo_request_log.create({
        data: {
          endpoint: "/api/EventGoods/Create",
          method: "POST",
          request_body: JSON.stringify(req.body),
          ip_address: req.ip || req.socket.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });

      logId = requestLog.id;

      const goods = 'params' in req.body && req.body.params
        ? (req.body.params as any).goods
        : 'goods' in req.body
        ? req.body.goods
        : null;

      if (!goods || !Array.isArray(goods)) {
        throw badRequest("Request body ต้องมี 'goods' เป็น array");
      }

      if (goods.length === 0) {
        throw badRequest("goods array ต้องมีข้อมูลอย่างน้อย 1 รายการ");
      }

      let createdCount = 0;
      const errors: string[] = [];

      for (const item of goods) {
        try {
          if (!item.product_id || !item.name) {
            throw new Error("product_id และ name จำเป็นต้องมี");
          }

          // เช็คว่ามีอยู่แล้วหรือไม่
          const existing = await prisma.wms_mdt_goods.findFirst({
            where: { product_id: item.product_id },
          });

          if (existing) {
            errors.push(`Product ID ${item.product_id} มีอยู่ในระบบแล้ว`);
            continue;
          }

          // สร้างใหม่
          await prisma.wms_mdt_goods.create({
            data: {
              product_id: item.product_id,
              product_code: item.code,
              product_name: item.name,
              product_type: item.type,
              tracking: item.tracking,
              department_id: item.department_id,
              department_name: item.department,
              zone_id: item.zone_id,
              zone_type: item.zone,
              unit: item.unit,
              active: item.active !== false,
              input_number: item.input_number ?? false,
              product_last_modified_date: new Date(),
            },
          });
          createdCount++;
        } catch (error: any) {
          errors.push(`Product ID ${item.product_id}: ${error.message}`);
        }
      }

      const responseBody = {
        success: true,
        message: `สร้างสินค้า ${createdCount} รายการสำเร็จ`,
        result: {
          created: createdCount,
          total: goods.length,
          errors: errors.length > 0 ? errors : undefined,
        },
      };

      if (logId) {
        await prisma.odoo_request_log.update({
          where: { id: logId },
          data: {
            response_status: 201,
            response_body: JSON.stringify(responseBody),
          },
        });
      }

      return res.status(201).json(responseBody);
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
  }
);

/**
 * POST /api/EventGoods/Update
 * อัพเดท goods ที่มีอยู่จาก Odoo
 */
export const updateEventGoods = asyncHandler(
  async (req: Request<{}, {}, EventGoodsRequestBody>, res: Response) => {
    let logId: number | null = null;

    try {
      const requestLog = await prisma.odoo_request_log.create({
        data: {
          endpoint: "/api/EventGoods/Update",
          method: "POST",
          request_body: JSON.stringify(req.body),
          ip_address: req.ip || req.socket.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });

      logId = requestLog.id;

      const goods = 'params' in req.body && req.body.params
        ? (req.body.params as any).goods
        : 'goods' in req.body
        ? req.body.goods
        : null;

      if (!goods || !Array.isArray(goods)) {
        throw badRequest("Request body ต้องมี 'goods' เป็น array");
      }

      if (goods.length === 0) {
        throw badRequest("goods array ต้องมีข้อมูลอย่างน้อย 1 รายการ");
      }

      let updatedCount = 0;
      const errors: string[] = [];

      for (const item of goods) {
        try {
          if (!item.product_id) {
            throw new Error("product_id จำเป็นต้องมี");
          }

          // หาสินค้าที่มีอยู่
          const existing = await prisma.wms_mdt_goods.findFirst({
            where: { product_id: item.product_id },
          });

          if (!existing) {
            errors.push(`Product ID ${item.product_id} ไม่พบในระบบ`);
            continue;
          }

          // อัพเดท
          await prisma.wms_mdt_goods.update({
            where: { id: existing.id },
            data: {
              product_code: item.code ?? undefined,
              product_name: item.name ?? undefined,
              product_type: item.type ?? undefined,
              tracking: item.tracking ?? undefined,
              department_id: item.department_id ?? undefined,
              department_name: item.department ?? undefined,
              zone_id: item.zone_id ?? undefined,
              zone_type: item.zone ?? undefined,
              unit: item.unit ?? undefined,
              active: item.active !== undefined ? item.active : undefined,
              input_number: item.input_number !== undefined ? item.input_number : undefined,
              product_last_modified_date: new Date(),
            },
          });
          updatedCount++;
        } catch (error: any) {
          errors.push(`Product ID ${item.product_id}: ${error.message}`);
        }
      }

      const responseBody = {
        success: true,
        message: `อัพเดทสินค้า ${updatedCount} รายการสำเร็จ`,
        result: {
          updated: updatedCount,
          total: goods.length,
          errors: errors.length > 0 ? errors : undefined,
        },
      };

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

/**
 * POST /api/EventGoods/Delete
 * ลบ (disable) goods จาก Odoo
 */
export const deleteEventGoods = asyncHandler(
  async (req: Request<{}, {}, EventGoodsRequestBody>, res: Response) => {
    let logId: number | null = null;

    try {
      const requestLog = await prisma.odoo_request_log.create({
        data: {
          endpoint: "/api/EventGoods/Delete",
          method: "POST",
          request_body: JSON.stringify(req.body),
          ip_address: req.ip || req.socket.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });

      logId = requestLog.id;

      const goods = 'params' in req.body && req.body.params
        ? (req.body.params as any).goods
        : 'goods' in req.body
        ? req.body.goods
        : null;

      if (!goods || !Array.isArray(goods)) {
        throw badRequest("Request body ต้องมี 'goods' เป็น array");
      }

      if (goods.length === 0) {
        throw badRequest("goods array ต้องมีข้อมูลอย่างน้อย 1 รายการ");
      }

      let deletedCount = 0;
      const errors: string[] = [];

      for (const item of goods) {
        try {
          if (!item.product_id) {
            throw new Error("product_id จำเป็นต้องมี");
          }

          // หาสินค้าที่มีอยู่
          const existing = await prisma.wms_mdt_goods.findFirst({
            where: { product_id: item.product_id },
          });

          if (!existing) {
            errors.push(`Product ID ${item.product_id} ไม่พบในระบบ`);
            continue;
          }

          // Soft delete (set active = false)
          await prisma.wms_mdt_goods.update({
            where: { id: existing.id },
            data: {
              active: false,
              product_last_modified_date: new Date(),
            },
          });
          deletedCount++;
        } catch (error: any) {
          errors.push(`Product ID ${item.product_id}: ${error.message}`);
        }
      }

      const responseBody = {
        success: true,
        message: `ปิดการใช้งานสินค้า ${deletedCount} รายการสำเร็จ`,
        result: {
          deleted: deletedCount,
          total: goods.length,
          errors: errors.length > 0 ? errors : undefined,
        },
      };

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
