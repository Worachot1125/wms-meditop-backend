import { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest } from "../utils/appError";
import { OdooAdjustRequest, OdooAdjustRequestParams } from "../types/adjust";
import { receiveOdooAdjustments } from "./adjust.controller";

type AdjustMode = "manual" | "auto";

function formatYYMMDD(d: Date | null | undefined): string {
  if (!d) return "999999";
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function buildAdjustmentBarcodePayload(input: {
  barcode: string;
  lot_serial: string | null | undefined;
  exp: Date | null | undefined;
}) {
  const barcode = String(input.barcode ?? "").trim().replace(/\s+/g, "");
  if (!barcode) return "";

  const lotPart = input.lot_serial
    ? String(input.lot_serial).trim().replace(/\s+/g, "")
    : "XXXXXX";

  const expPart = formatYYMMDD(input.exp);
  return `${barcode}${lotPart}${expPart}`;
}

function parseOdooExpireDate(v: unknown): Date | null {
  if (!v) return null;

  const s = String(v).trim();
  if (!s || s === "false") return null;

  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);

  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) {
    return null;
  }

  return new Date(Date.UTC(y, mo - 1, d));
}

function extractAdjusts(body: any) {
  if (body?.params?.adjusts) return body.params.adjusts;
  if (body?.adjusts) return body.adjusts;
  return null;
}

function detectAdjustMode(body: any): AdjustMode {
  const adjusts = extractAdjusts(body);

  if (!adjusts) {
    throw badRequest("ไม่พบข้อมูล 'adjusts' ใน request body");
  }
  if (!Array.isArray(adjusts)) {
    throw badRequest("'adjusts' ต้องเป็น Array");
  }
  if (adjusts.length === 0) {
    throw badRequest("'adjusts' ต้องมีข้อมูลอย่างน้อย 1 รายการ");
  }

  const hasAuto = adjusts.some((adj: any) => adj?.is_system_generated === true);
  const hasManual = adjusts.some((adj: any) => adj?.is_system_generated !== true);

  if (hasAuto && hasManual) {
    throw badRequest("request เดียวห้ามมีทั้ง auto และ manual adjustment ปนกัน");
  }

  return hasAuto ? "auto" : "manual";
}

function deriveType(no?: string | null) {
  if (!no) return null;
  const m = no.match(/^([A-Za-z]{2,3})[-_/]/);
  return m ? m[1].toUpperCase() : null;
}

function deriveLevel(adjust: {
  picking_id?: number | null;
  picking_no?: string | null;
}) {
  return adjust.picking_id || adjust.picking_no ? "in-process" : "post-process";
}

function normalizeRef(v: any): string | null {
  if (v == null) return null;
  if (typeof v === "boolean") return v ? "true" : null;

  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function normalizeOrigin(v: any): string | null {
  if (v == null) return null;

  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function normalizeString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function normalizeStringOrArray(v: unknown): string | null {
  if (v == null) return null;

  if (Array.isArray(v)) {
    const arr = v.map((x) => String(x ?? "").trim()).filter(Boolean);
    return arr.length > 0 ? arr.join(", ") : null;
  }

  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function normalizeDepartments(departments: any) {
  let department_id: string | null = null;
  let department = "";

  if (Array.isArray(departments) && departments.length > 0) {
    const firstId = departments.find(
      (d) => d?.department_id != null,
    )?.department_id;

    const names = departments
      .map((d) => (typeof d?.department === "string" ? d.department : null))
      .filter(Boolean);

    department_id = firstId != null ? String(firstId) : null;
    department = names.join(", ");

    return { department_id, department };
  }

  if (typeof departments === "string") {
    return {
      department_id: null,
      department: departments.trim(),
    };
  }

  if (typeof departments === "object" && departments !== null) {
    if ((departments as any).department_id != null) {
      department_id = String((departments as any).department_id);
    }
    if (typeof (departments as any).department === "string") {
      department = (departments as any).department;
    }
  }

  return { department_id, department };
}

function resolveDepartmentSource(adjust: any) {
  if (Array.isArray(adjust?.departments) && adjust.departments.length > 0) {
    return adjust.departments;
  }

  if (Array.isArray(adjust?.department) && adjust.department.length > 0) {
    return adjust.department;
  }

  if (adjust?.departments != null) return adjust.departments;
  if (adjust?.department != null) return adjust.department;

  return null;
}

function normalizeDescription(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

async function upsertAdjustmentHeader(adjust: any) {
  const {
    inventory_id,
    no,
    picking_id,
    picking_no,
    reference,
    origin,
    description,
    department_id,
    department,
    is_system_generated,
  } = adjust as any;

  const depSource = resolveDepartmentSource(adjust);
  const dep = normalizeDepartments(depSource);

  const depIdFinal =
    dep.department_id ?? (department_id != null ? String(department_id) : null);

  const depNameFinal =
    dep.department && dep.department.trim().length > 0
      ? dep.department
      : typeof department === "string"
        ? department
        : "";

  const type = deriveType(no);
  const level = deriveLevel({ picking_id, picking_no });
  const systemGenerated = is_system_generated === true;

  if (inventory_id != null) {
    const existing = await prisma.adjustment.findFirst({
      where: { inventory_id },
    });

    if (existing) {
      return prisma.adjustment.update({
        where: { id: existing.id },
        data: {
          no,
          picking_id,
          picking_no,
          department_id: depIdFinal,
          department: depNameFinal || "",
          reference: normalizeRef(reference),
          origin: normalizeOrigin(origin),
          description: normalizeDescription(description),
          type,
          level,
          is_system_generated: systemGenerated,
          updated_at: new Date(),
        },
      });
    }

    return prisma.adjustment.create({
      data: {
        no,
        inventory_id,
        picking_id,
        picking_no,
        department_id: depIdFinal,
        department: depNameFinal || "",
        reference: normalizeRef(reference),
        origin: normalizeOrigin(origin),
        description: normalizeDescription(description),
        type,
        level,
        is_system_generated: systemGenerated,
        date: new Date(),
      },
    });
  }

  return prisma.adjustment.create({
    data: {
      no,
      inventory_id: null,
      picking_id,
      picking_no,
      department_id: depIdFinal,
      department: depNameFinal || "",
      reference: normalizeRef(reference),
      origin: normalizeOrigin(origin),
      description: normalizeDescription(description),
      type,
      level,
      is_system_generated: systemGenerated,
      date: new Date(),
    },
  });
}

async function upsertAdjustmentItems(adjustmentId: number, items: any[]) {
  const itemResults = await Promise.all(
    items.map(async (item: any, index: number) => {
      const seq = item.sequence ?? index + 1;

      const existingItem = await prisma.adjustment_item.findFirst({
        where: {
          adjustment_id: adjustmentId,
          sequence: seq,
        },
      });

      const expDate = parseOdooExpireDate(
        item.expire_date ?? item.exp ?? item.expiration_date,
      );

      const barcodeBase = typeof item.code === "string" ? item.code : "";

      const barcodePayload = buildAdjustmentBarcodePayload({
        barcode: barcodeBase,
        lot_serial: item.lot_serial,
        exp: expDate,
      });

      const data = {
        product_id: item.product_id ?? null,
        code: item.code ?? null,
        name: item.name,
        unit: item.unit,

        location_id: item.location_id ?? null,
        location: normalizeString(item.location),

        location_owner: normalizeStringOrArray(item.location_owner),
        location_owner_display: normalizeStringOrArray(
          item.location_owner_display,
        ),

        location_dest_id: item.location_dest_id ?? null,
        location_dest: normalizeString(item.location_dest),
        location_dest_owner: normalizeStringOrArray(item.location_dest_owner),
        location_dest_owner_display: normalizeStringOrArray(
          item.location_dest_owner_display,
        ),

        tracking: normalizeString(item.tracking),
        lot_id: item.lot_id ?? null,
        lot_serial: normalizeString(item.lot_serial),

        exp: expDate,
        barcode_payload: barcodePayload || null,

        qty: item.qty ?? null,
        updated_at: new Date(),
      };

      if (existingItem) {
        return prisma.adjustment_item.update({
          where: { id: existingItem.id },
          data,
        });
      }

      return prisma.adjustment_item.create({
        data: {
          adjustment_id: adjustmentId,
          sequence: seq,
          ...data,
        },
      });
    }),
  );

  return itemResults;
}

async function processSingleAdjust(adjust: any, mode: AdjustMode) {
  const { inventory_id, no, items, is_system_generated } = adjust as any;

  if (!Array.isArray(items) || items.length === 0) {
    throw badRequest(`Adjustment ${no ?? inventory_id ?? ""} ไม่มี items`);
  }

  const adjustmentRow = await upsertAdjustmentHeader(adjust);
  await upsertAdjustmentItems(adjustmentRow.id, items);

  return {
    inventory_id: inventory_id ?? null,
    adjustment_no: no ?? "",
    adjustment_id: adjustmentRow.id,
    items_count: items.length,
    mode,
    is_system_generated: is_system_generated === true,
    status: "success",
  };
}

async function processManualAdjust(adjust: any) {
  return processSingleAdjust(adjust, "manual");
}

/**
 * POST /api/AdjustManual
 * - auto  -> ใช้ receiveOdooAdjustments
 * - manual -> ใช้ flow เดิม
 */
export const receiveAdjustFromOdoo = asyncHandler(
  async (
    req: Request<{}, {}, OdooAdjustRequest | OdooAdjustRequestParams>,
    res: Response,
    next: NextFunction,
  ) => {
    const mode = detectAdjustMode(req.body);

    if (mode === "auto") {
      return receiveOdooAdjustments(req as Request, res, next);
    }

    let logId: number | null = null;

    try {
      const requestLog = await prisma.odoo_request_log.create({
        data: {
          endpoint: "/api/AdjustManual",
          method: "POST",
          request_body: JSON.stringify(req.body),
          ip_address: req.ip || req.socket.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });

      logId = requestLog.id;

      const adjusts = extractAdjusts(req.body);

      if (!adjusts) {
        throw badRequest("ไม่พบข้อมูล 'adjusts' ใน request body");
      }
      if (!Array.isArray(adjusts)) {
        throw badRequest("'adjusts' ต้องเป็น Array");
      }
      if (adjusts.length === 0) {
        throw badRequest("'adjusts' ต้องมีข้อมูลอย่างน้อย 1 รายการ");
      }

      const results: any[] = [];
      const manualResults: any[] = [];

      for (const adjust of adjusts) {
        const result = await processManualAdjust(adjust);
        manualResults.push(result);
        results.push(result);
      }

      const responseBody = {
        success: true,
        message: "Inventory Adjustment received successfully",
        summary: {
          total: results.length,
          manual_count: manualResults.length,
          auto_count: 0,
        },
        manual_results: manualResults,
        auto_results: [],
        results,
      };

      await prisma.odoo_request_log.update({
        where: { id: logId },
        data: {
          response_status: 200,
          response_body: JSON.stringify(responseBody),
        },
      });

      return res.status(200).json(responseBody);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (logId) {
        await prisma.odoo_request_log.update({
          where: { id: logId },
          data: {
            response_status: 500,
            error_message: errorMessage,
          },
        });
      }

      throw error;
    }
  },
);