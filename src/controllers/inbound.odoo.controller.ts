import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler";
import { badRequest, notFound } from "../utils/appError";
import { OdooInboundRequest, OdooInboundRequestParams } from "../types/inbound";
import { formatOdooInbound } from "../utils/formatters/odoo_inbound.formatter";
import {
  buildZoneTypeMapByProductId,
  buildInputNumberMapByLotText,
} from "../utils/inbound/inbound.wms.helper";
import {
  normalizeLotText,
  mergeInboundItems,
  isPDNumber,
  isRTCNumber,
  isTFNumber,
} from "../utils/inbound/inbound.normalize.helper";
import {
  isBorrowStoreTransferLike,
  handleSwapTransfer,
} from "../utils/inbound/inbound.swap.helper";
import { handlePDAutoProcess } from "../utils/inbound/inbound.pd.helper";
import {
  handleTFTransfer,
  handleInboundTransfer,
} from "../utils/inbound/inbound.transfer.helper";
import { handleRTCReturnTransfer } from "../utils/inbound/inbound.rtc.helper";
import { attachBarcodeByText } from "../utils/inbound/inbound.barcode.helper";
import {
  resolveInputNumber,
  buildZoneTypeMapByLotText,
  resolveZoneType,
} from "../utils/inbound/inbound.wms.helper";

/**
 * ✅ เลือก lot_text สำหรับ item (lot_serial มาก่อน ถ้าไม่มีค่อยใช้ lot)
 */
export const resolveLotText = (input: {
  lot_serial?: any;
  lot?: any;
}): string => {
  const ls = normalizeLotText(input.lot_serial);
  if (ls) return ls;
  const l = normalizeLotText(input.lot);
  return l;
};

/**
 * ==============
 * 1) Receive from Odoo (NEW barcode_text policy)
 * ==============
 */
export const receiveFromOdoo = asyncHandler(
  async (
    req: Request<{}, {}, OdooInboundRequest | OdooInboundRequestParams>,
    res: Response,
  ) => {
    let logId: number | null = null;

    const getErrorStatus = (err: unknown) => {
      const anyErr = err as any;
      return anyErr?.statusCode ?? anyErr?.status ?? anyErr?.httpStatus ?? 500;
    };

    try {
      const requestLog = await prisma.odoo_request_log.create({
        data: {
          endpoint: "/api/Inbound",
          method: "POST",
          request_body: JSON.stringify(req.body),
          ip_address: req.ip || req.socket.remoteAddress || null,
          user_agent: req.headers["user-agent"] || null,
        },
      });

      logId = requestLog.id;

      const transfers =
        "params" in req.body && (req.body as any).params
          ? (req.body as any).params.transfers
          : "transfers" in req.body
            ? (req.body as any).transfers
            : null;

      if (!transfers) throw badRequest("ไม่พบข้อมูล 'transfers'");
      if (!Array.isArray(transfers)) {
        throw badRequest("'transfers' ต้องเป็น Array");
      }
      if (transfers.length === 0) {
        throw badRequest("'transfers' ต้องมีข้อมูลอย่างน้อย 1 รายการ");
      }

      const results: any[] = [];

      for (const transfer of transfers) {
        const picking_id = (transfer as any).picking_id;

        const number = String(
          (transfer as any).number ?? (transfer as any).no ?? "",
        ).trim();

        const location_id = (transfer as any).location_id;
        const location = (transfer as any).location;
        const location_dest_id = (transfer as any).location_dest_id;
        const location_dest = (transfer as any).location_dest;

        const location_dest_owner = (transfer as any).location_dest_owner;
        const location_dest_owner_display = (transfer as any)
          .location_dest_owner_display;

        const department_id = (transfer as any).department_id;
        const department = (transfer as any).department;
        const reference = (transfer as any).reference;
        const origin = (transfer as any).origin;
        const invoice = (transfer as any).invoice;
        const in_type = (transfer as any).in_type;
        const items = (transfer as any).items;

        if (!number) throw badRequest("ไม่พบเลข number/no ใน transfer");

        if (!items || !Array.isArray(items) || items.length === 0) {
          throw badRequest(`Transfer ${number} ไม่มี items`);
        }

        const mergedItems = mergeInboundItems(items);

        // ✅ BOR/BOS internal transfer -> swap / swap_item
        if (
          isBorrowStoreTransferLike({
            location,
            location_dest,
            location_dest_owner,
          })
        ) {
          const swap = await handleSwapTransfer({
            picking_id,
            number,
            location_id,
            location,
            location_dest_id,
            location_dest,
            location_dest_owner,
            location_dest_owner_display,
            department_id,
            department,
            reference,
            origin,
            mergedItems,
          });

          results.push(swap);
          continue;
        }

        // ✅ PD -> auto-process เหมือน RTC case ลด outbound
        if (isPDNumber(number)) {
          const pd = await handlePDAutoProcess({
            picking_id,
            number,
            location_id,
            location,
            location_dest_id,
            location_dest,
            department_id,
            department,
            reference,
            origin,
            invoice,
            mergedItems,
          });

          results.push(pd);
          continue;
        }

        if (isRTCNumber(number)) {
          const rtc = await handleRTCReturnTransfer({
            picking_id,
            number,
            location_id,
            location,
            location_dest_id,
            location_dest,
            department_id,
            department,
            reference,
            origin,
            invoice,
            mergedItems,
          });

          results.push(rtc);
          continue;
        }

        // ✅ TF -> transfer_doc / transfer_doc_item
        if (isTFNumber(number)) {
          const doc = await handleTFTransfer({
            picking_id,
            number,
            location_id,
            location,
            location_dest_id,
            location_dest,
            department_id,
            department,
            reference,
            origin,
            mergedItems,
          });

          results.push(doc);
          continue;
        }

        // ✅ BOR และ non-TF อื่น ๆ -> inbound / goods_in ปกติ
        const inbound = await handleInboundTransfer({
          picking_id,
          number,
          location_id,
          location,
          location_dest_id,
          location_dest,
          department_id,
          department,
          reference,
          origin,
          invoice,
          mergedItems,
        });

        results.push(inbound);
      }

      const responseBody = {
        success: true,
        message: `รับข้อมูลจาก Odoo สำเร็จ ${results.length} รายการ`,
        total_received: transfers.length,
        total_processed: results.length,
        data: results,
      };

      if (logId) {
        await prisma.odoo_request_log.update({
          where: { id: logId },
          data: {
            response_status: 200,
            response_body: JSON.stringify(responseBody),
            error_message: null,
          },
        });
      }

      return res.status(200).json(responseBody);
    } catch (err) {
      const status = getErrorStatus(err);
      const message =
        err instanceof Error
          ? err.message
          : "เกิดข้อผิดพลาดในการรับข้อมูลจาก Odoo";

      if (logId) {
        await prisma.odoo_request_log.update({
          where: { id: logId },
          data: {
            response_status: status,
            response_body: null,
            error_message: message,
          },
        });
      }

      throw err;
    }
  },
);

/**
 * ==============
 * 2) GET list (all inbounds)
 * ==============
 */
export const getOdooInbounds = asyncHandler(
  async (req: Request, res: Response) => {
    const inbounds = await prisma.inbound.findMany({
      where: {
        deleted_at: null,
        picking_id: { not: null },
      },
      include: {
        goods_ins: {
          where: {
            deleted_at: null,
            inbound_id: { not: null },
          },
          orderBy: { sequence: "asc" },
        },
      },
      orderBy: { created_at: "desc" },
    });

    // Lookup department short_name
    const departmentIds = [
      ...new Set(
        inbounds
          .map((ib) => ib.department_id)
          .filter((id): id is string => id != null)
          .map((id) => parseInt(id, 10))
          .filter((id) => !isNaN(id)),
      ),
    ];

    const deptMap = new Map<number, string>();
    if (departmentIds.length > 0) {
      const departments = await prisma.department.findMany({
        where: { odoo_id: { in: departmentIds } },
        select: { odoo_id: true, short_name: true },
      });
      departments.forEach((dept) => {
        if (dept.odoo_id) deptMap.set(dept.odoo_id, dept.short_name);
      });
    }

    // ✅ barcode lookup by barcode_text
    const allGoods = inbounds.flatMap((ib) => ib.goods_ins || []);
    const { map: barcodeMap } = await attachBarcodeByText(allGoods as any);

    const formattedData = inbounds.map((inbound) => {
      const formatted = formatOdooInbound(inbound as any);
      const deptId = inbound.department_id
        ? parseInt(inbound.department_id, 10)
        : NaN;
      const shortName = !isNaN(deptId) ? deptMap.get(deptId) : undefined;

      return {
        ...formatted,
        invoice: (inbound as any).invoice ?? null,
        department: shortName ?? formatted.department,
        items: (inbound.goods_ins || []).map((gi) => {
          const t = (gi.barcode_text ?? "").trim();
          const b = t ? barcodeMap.get(t) : null;

          return {
            id: gi.id,
            inbound_id: gi.inbound_id,
            sequence: gi.sequence,
            product_id: gi.product_id,
            code: gi.code,
            name: gi.name,
            unit: gi.unit,
            tracking: gi.tracking,
            lot_id: gi.lot_id, // ✅ ยังคงส่ง
            lot_serial: gi.lot_serial,
            qty: gi.qty,
            quantity_receive: gi.quantity_receive,
            quantity_count: gi.quantity_count,
            lot: gi.lot,
            exp: gi.exp,
            print_check: Boolean(gi.print_check),

            barcode_text: gi.barcode_text ?? null,
            barcode: b
              ? {
                  barcode: b.barcode,
                  lot_start: b.lot_start ?? null,
                  lot_stop: b.lot_stop ?? null,
                  exp_start: b.exp_start ?? null,
                  exp_stop: b.exp_stop ?? null,
                  barcode_length: b.barcode_length ?? null,
                }
              : null,

            created_at: gi.created_at,
            updated_at: gi.updated_at,
          };
        }),
      };
    });

    return res.json({
      total: formattedData.length,
      data: formattedData,
    });
  },
);

/**
 * ==============
 * 3) GET by no (full)
 * ==============
 */
export const getOdooInboundByNo = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const rawNo = Array.isArray(req.params.no)
      ? req.params.no[0]
      : req.params.no;

    if (!rawNo) throw badRequest("กรุณาระบุเลข no");

    const no = decodeURIComponent(rawNo);

    const inboundRaw = await prisma.inbound.findUnique({
      where: { no },
      include: {
        goods_ins: {
          where: { deleted_at: null },
          orderBy: { sequence: "asc" },
          include: {
            goods_in_location_confirms: {
              include: {
                location: {
                  select: {
                    id: true,
                    full_name: true,
                    lock_no: true,
                    ncr_check: true,
                  },
                },
              },
              orderBy: [{ updated_at: "desc" }, { id: "desc" }],
            },
          },
        },
      },
    });

    const inbound = inboundRaw as any;

    if (!inbound) throw notFound(`ไม่พบ Inbound no: ${no}`);
    if (inbound.deleted_at) throw badRequest("Inbound นี้ถูกลบไปแล้ว");

    let departmentShortName: string | undefined;

    if (inbound.department_id) {
      const deptId = parseInt(inbound.department_id, 10);

      if (!isNaN(deptId)) {
        const dept = await prisma.department.findFirst({
          where: { odoo_id: deptId },
          select: { short_name: true },
        });

        departmentShortName = dept?.short_name;
      }
    }

    const goodsIns = Array.isArray(inbound.goods_ins) ? inbound.goods_ins : [];

    const goodsList = goodsIns
      .filter((gi: any) => gi.product_id != null)
      .map((gi: any) => ({
        product_id: gi.product_id,
        lot_id: gi.lot_id ?? null,
        lot_text: resolveLotText({
          lot_serial: gi.lot_serial,
          lot: gi.lot,
        }),
      }));

    const inputNumberMap = await buildInputNumberMapByLotText(goodsList);

    const zoneTypeMap = await buildZoneTypeMapByProductId(
      goodsIns.map((gi: any) => ({
        product_id: gi.product_id,
      })),
    );

    const productIds: number[] = Array.from(
      new Set<number>(
        goodsIns
          .map((gi: any) => Number(gi.product_id))
          .filter((x: number) => Number.isFinite(x)),
      ),
    );

    const stockRows =
      productIds.length > 0
        ? await prisma.stock.findMany({
            where: {
              active: true,
              quantity: {
                gt: 0,
              },
              product_id: {
                in: productIds,
              },
            },
            select: {
              product_id: true,
              lot_id: true,
              lot_name: true,
              expiration_date: true,
              quantity: true,
              location_id: true,
              location_name: true,
            },
            orderBy: [
              { location_name: "asc" },
              { product_id: "asc" },
              { lot_name: "asc" },
            ],
          })
        : [];

    const normText = (v: any) =>
      String(v ?? "")
        .trim()
        .toLowerCase();

    const normDate = (v: any) => {
      if (!v) return "";

      const d = new Date(v);

      if (Number.isNaN(d.getTime())) {
        return String(v).slice(0, 10);
      }

      return d.toISOString().slice(0, 10);
    };

    const sameInboundStock = (gi: any, st: any) => {
      if (gi.product_id == null || st.product_id == null) return false;
      if (Number(gi.product_id) !== Number(st.product_id)) return false;

      const giLotId = gi.lot_id ?? null;
      const stLotId = st.lot_id ?? null;

      if (giLotId != null && stLotId != null) {
        if (Number(giLotId) !== Number(stLotId)) return false;
      } else {
        const giLot = normText(gi.lot_serial ?? gi.lot);
        const stLot = normText(st.lot_name);

        if (giLot || stLot) {
          if (giLot !== stLot) return false;
        }
      }

      const giExp = normDate(gi.exp);
      const stExp = normDate(st.expiration_date);

      if (giExp || stExp) {
        if (giExp !== stExp) return false;
      }

      return true;
    };

    const buildInboundLockLocations = (gi: any) => {
      const map = new Map<
        string,
        {
          location_id: number | null;
          location_name: string | null;
          qty: number;
        }
      >();

      for (const st of stockRows as any[]) {
        if (!sameInboundStock(gi, st)) continue;

        const key = `${st.location_id ?? "null"}|${st.location_name ?? ""}`;
        const qty = Number(st.quantity ?? 0);

        const old = map.get(key);

        if (old) {
          old.qty += qty;
        } else {
          map.set(key, {
            location_id: st.location_id ?? null,
            location_name: st.location_name ?? null,
            qty,
          });
        }
      }

      return Array.from(map.values()).sort((a, b) =>
        String(a.location_name ?? "").localeCompare(
          String(b.location_name ?? ""),
          "en",
          {
            sensitivity: "base",
            numeric: true,
          },
        ),
      );
    };

    const { map: barcodeMap } = await attachBarcodeByText(goodsIns as any);

    const formattedInbound = formatOdooInbound(inbound as any);

    return res.json({
      ...formattedInbound,
      invoice: inbound.invoice ?? null,
      department: departmentShortName ?? formattedInbound.department,

      items: goodsIns.map((gi: any) => {
        const input_number = resolveInputNumber(
          inputNumberMap,
          gi.product_id,
          gi.lot_serial,
          gi.lot,
          gi.lot_id ?? null,
        );

        const zone_type =
          gi.product_id != null
            ? (zoneTypeMap.get(gi.product_id) ?? null)
            : null;

        const t = (gi.barcode_text ?? "").trim();
        const b = t ? barcodeMap.get(t) : null;

        const receive_locations = (gi.goods_in_location_confirms || []).map(
          (cf: any) => ({
            id: cf.id,
            location_id: cf.location_id,
            confirmed_qty: cf.confirmed_qty ?? 0,
            qty: cf.confirmed_qty ?? 0,
            created_at: cf.created_at,
            updated_at: cf.updated_at,
            location: cf.location
              ? {
                  id: cf.location.id,
                  full_name: cf.location.full_name,
                  lock_no: cf.location.lock_no ?? null,
                  ncr_check: Boolean(cf.location.ncr_check),
                }
              : null,
            location_name: cf.location?.full_name ?? null,
          }),
        );

        const lock_locations = buildInboundLockLocations(gi);

        const lock_no = lock_locations.map(
          (x) => `${x.location_name ?? "-"} (จำนวน ${x.qty})`,
        );

        return {
          id: gi.id,
          inbound_id: gi.inbound_id,
          sequence: gi.sequence,
          product_id: gi.product_id,
          code: gi.code,
          name: gi.name,
          unit: gi.unit,
          tracking: gi.tracking,
          lot_id: gi.lot_id,
          lot_serial: gi.lot_serial,

          zone_type,
          user_ref: gi.user_ref ?? null,

          qty: gi.qty,
          quantity_receive: gi.quantity_receive,
          quantity_count: gi.quantity_count,
          lot: gi.lot,
          exp: gi.exp,

          receive_locations,
          location_confirms: receive_locations,

          lock_no,
          lock_locations,

          location_name: lock_no,
          locations: lock_locations,

          odoo_line_key: gi.odoo_line_key,
          odoo_sequence: gi.odoo_sequence,
          input_number,
          print_check: Boolean(gi.print_check),

          barcode_text: gi.barcode_text ?? null,
          barcode: b
            ? {
                barcode: b.barcode,
                lot_start: b.lot_start ?? null,
                lot_stop: b.lot_stop ?? null,
                exp_start: b.exp_start ?? null,
                exp_stop: b.exp_stop ?? null,
                barcode_length: b.barcode_length ?? null,
              }
            : null,

          created_at: gi.created_at,
          updated_at: gi.updated_at,
        };
      }),
    });
  },
);

/**
 * ==============
 * 4) GET by no (Paginated)
 * ==============
 */
export const getOdooInboundByNoPaginated = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const rawNo = Array.isArray(req.params.no)
      ? req.params.no[0]
      : req.params.no;
    if (!rawNo) throw badRequest("กรุณาระบุเลข no");
    const no = decodeURIComponent(rawNo);

    // Pagination
    const page = Number(req.query.page) || 1;
    const limit =
      req.query.limit !== undefined ? Number(req.query.limit) || 10 : 10;
    if (isNaN(page) || page < 1)
      throw badRequest("page ต้องเป็นตัวเลขบวกที่มีค่ามากกว่า 0");
    const skip = (page - 1) * limit;

    // Search
    const rawSearch = req.query.search;
    const search = typeof rawSearch === "string" ? rawSearch.trim() : "";

    // Inbound header
    const inbound = await prisma.inbound.findUnique({ where: { no } });
    if (!inbound) throw notFound(`ไม่พบ Inbound no: ${no}`);
    if (inbound.deleted_at) throw badRequest("Inbound นี้ถูกลบไปแล้ว");

    // Department short_name
    let departmentShortName: string | undefined;
    if (inbound.department_id) {
      const deptId = parseInt(inbound.department_id, 10);
      if (!isNaN(deptId)) {
        const dept = await prisma.department.findFirst({
          where: { odoo_id: deptId },
          select: { short_name: true },
        });
        departmentShortName = dept?.short_name;
      }
    }

    // WHERE goods_ins
    const baseWhere: Prisma.goods_inWhereInput = {
      inbound_id: inbound.id,
      deleted_at: null,
    };

    let where: Prisma.goods_inWhereInput = baseWhere;

    if (search) {
      const searchCondition: Prisma.goods_inWhereInput = {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { code: { contains: search, mode: "insensitive" } },
          { lot: { contains: search, mode: "insensitive" } },
          { lot_serial: { contains: search, mode: "insensitive" } },
          { tracking: { contains: search, mode: "insensitive" } },
          { barcode_text: { contains: search, mode: "insensitive" } },
        ],
      };

      if (!isNaN(Number(search))) {
        searchCondition.OR?.push({ qty: { equals: Number(search) } });
      }

      where = { AND: [baseWhere, searchCondition] };
    }

    // Query items + count
    const [items, total] = await Promise.all([
      prisma.goods_in.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: "asc" },
      }),
      prisma.goods_in.count({ where }),
    ]);

    // ✅ goodsList สำหรับ map: product_id + lot_serial(lot_name) (ไม่เช็ค lot_id)
    const goodsList = items
      .filter((gi) => gi.product_id != null)
      .map((gi) => ({
        product_id: gi.product_id!,
        lot_id: gi.lot_id ?? null, // ✅ ใช้ query ได้ แต่ไม่ใช้เป็น key เช็ค
        lot_text: resolveLotText({ lot_serial: gi.lot_serial, lot: gi.lot }),
      }));

    const inputNumberMap = await buildInputNumberMapByLotText(goodsList);
    const zoneTypeMap = await buildZoneTypeMapByLotText(goodsList);

    // ✅ barcode lookup by barcode_text
    const { map: barcodeMap } = await attachBarcodeByText(items as any);

    return res.json({
      inbound: {
        id: inbound.id,
        picking_id: inbound.picking_id,
        no: inbound.no,
        lot: inbound.lot,
        location_id: inbound.location_id,
        location: inbound.location,
        location_dest_id: inbound.location_dest_id,
        location_dest: inbound.location_dest,
        department_id: inbound.department_id,
        department: departmentShortName ?? inbound.department,
        reference: inbound.reference,
        origin: inbound.origin,
        invoice: inbound.invoice ?? null,
        date: inbound.date,
        in_type: inbound.in_type,
        created_at: inbound.created_at,
        updated_at: inbound.updated_at,
      },
      data: items.map((gi) => {
        const input_number = resolveInputNumber(
          inputNumberMap,
          gi.product_id,
          gi.lot_serial,
          gi.lot,
          gi.lot_id ?? null,
        );

        const zone_type = resolveZoneType(
          zoneTypeMap,
          gi.product_id,
          gi.lot_serial,
          gi.lot,
          gi.lot_id ?? null,
        );

        const t = (gi.barcode_text ?? "").trim();
        const b = t ? barcodeMap.get(t) : null;

        return {
          id: gi.id,
          inbound_id: gi.inbound_id,
          sequence: gi.sequence,
          product_id: gi.product_id,
          code: gi.code,
          name: gi.name,
          unit: gi.unit,
          tracking: gi.tracking,
          lot_id: gi.lot_id, // ✅ ยังส่ง
          lot_serial: gi.lot_serial,

          zone_type,
          user_ref: (gi as any).user_ref ?? null,

          qty: gi.qty,
          quantity_receive: gi.quantity_receive,
          quantity_count: gi.quantity_count,
          lot: gi.lot,
          exp: gi.exp,

          odoo_line_key: gi.odoo_line_key,
          odoo_sequence: gi.odoo_sequence,
          input_number,
          print_check: Boolean(gi.print_check),

          barcode_text: gi.barcode_text ?? null,
          barcode: b
            ? {
                barcode: b.barcode,
                lot_start: b.lot_start ?? null,
                lot_stop: b.lot_stop ?? null,
                exp_start: b.exp_start ?? null,
                exp_stop: b.exp_stop ?? null,
                barcode_length: b.barcode_length ?? null,
              }
            : null,

          created_at: gi.created_at,
          updated_at: gi.updated_at,
        };
      }),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },
);

export const updateOdooInbound = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;
    const data = req.body;

    if (!no) throw badRequest("กรุณาระบุเลข no");

    const existing = await prisma.inbound.findUnique({
      where: { no },
      select: { id: true, deleted_at: true },
    });
    if (!existing) throw notFound(`ไม่พบ Inbound no: ${no}`);
    if (existing.deleted_at)
      throw badRequest("ไม่สามารถแก้ไข Inbound ที่ถูกลบแล้ว");

    // ✅ payload จริงส่งมา { lot: "..." }
    const lotText =
      data.lot !== undefined
        ? data.lot === null
          ? null
          : String(data.lot).trim() || null
        : undefined;

    const invoiceText =
      data.invoice !== undefined
        ? data.invoice === null
          ? null
          : String(data.invoice).trim() || null
        : undefined;

    const result = await prisma.$transaction(async (tx) => {
      // 1) update inbound header (ของเดิม)
      const inboundHeader = await tx.inbound.update({
        where: { no },
        data: {
          picking_id: data.picking_id ?? undefined,
          location_id: data.location_id ?? undefined,
          location: data.location ?? undefined,
          location_dest_id: data.location_dest_id ?? undefined,
          location_dest: data.location_dest ?? undefined,
          department_id: data.department_id?.toString() ?? undefined,
          department: data.department ?? undefined,
          reference: data.reference ?? undefined,
          origin: data.origin ?? undefined,
          invoice: invoiceText !== undefined ? invoiceText : undefined,
          updated_at: new Date(),

          // ถ้ามี lot ที่ header ก็อัปเดตไปด้วย
          lot: lotText !== undefined ? lotText : undefined,
        },
        select: { id: true },
      });

      // 2) ✅ update goods_ins: lot + lot_serial
      let updatedGoodsIns = 0;

      if (lotText !== undefined) {
        const r = await tx.goods_in.updateMany({
          where: {
            inbound_id: inboundHeader.id,
            deleted_at: null,
          },
          data: {
            lot: lotText,
            lot_serial: lotText,
            updated_at: new Date(),
          },
        });
        updatedGoodsIns = r.count;
      }

      // 3) return full inbound
      const full = await tx.inbound.findUniqueOrThrow({
        where: { no },
        include: {
          goods_ins: {
            where: { deleted_at: null },
            orderBy: { sequence: "asc" },
          },
        },
      });

      return { full, updatedGoodsIns, lotText };
    });

    return res.json({
      message: "อัพเดท Inbound สำเร็จ",
      debug: {
        lotText: result.lotText,
        updatedGoodsIns: result.updatedGoodsIns,
      },
      data: formatOdooInbound(result.full),
    });
  },
);

export const deleteOdooInbound = asyncHandler(
  async (req: Request<{ no: string }>, res: Response) => {
    const no = Array.isArray(req.params.no) ? req.params.no[0] : req.params.no;

    if (!no) throw badRequest("กรุณาระบุเลข no");

    const existing = await prisma.inbound.findUnique({
      where: { no },
      include: { goods_ins: true },
    });

    if (!existing) throw notFound(`ไม่พบ Inbound no: ${no}`);
    if (existing.deleted_at) throw badRequest("Inbound นี้ถูกลบไปแล้ว");

    await prisma.inbound.update({
      where: { no },
      data: {
        deleted_at: new Date(),
        updated_at: new Date(),
      },
    });

    if (existing.goods_ins.length > 0) {
      await prisma.goods_in.updateMany({
        where: {
          inbound_id: existing.id,
          deleted_at: null,
        },
        data: {
          deleted_at: new Date(),
          updated_at: new Date(),
        },
      });
    }

    return res.json({
      message: `ลบ Inbound ${no} และ ${existing.goods_ins.length} items สำเร็จ`,
    });
  },
);
