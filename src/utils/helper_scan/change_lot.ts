import { prisma } from "../../lib/prisma";
import { Prisma } from "@prisma/client";
import axios from "axios";
import crypto from "crypto";

function normalizeLotSerialForMatch(v: unknown): string {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}


export function buildOutboundLotAdjustmentOdooItem(row: {
  qty?: number | null;
  code?: string | null;
  name?: string | null;
  unit?: string | null;
  lot_id?: number | null;
  lot_serial?: string | null;
  product_id?: number | null;
  tracking?: string | null;
  sequence?: number | null;
  barcode_text?: string | null;
}, outbound: {
  location?: string | null;
  location_id?: number | null;
  location_dest?: string | null;
  location_dest_id?: number | null;
}, reference: string | null) {
  return {
    qty: Math.max(0, Math.floor(Number(row.qty ?? 0))),
    code: row.code,
    name: row.name,
    unit: row.unit,
    lot_id: row.lot_id ?? null,
    lot_serial: row.lot_serial ?? null,
    product_id: row.product_id ?? null,
    tracking: row.tracking ?? null,
    sequence: row.sequence ?? null,
    location: outbound.location ?? null,
    location_id: outbound.location_id ?? null,
    location_dest: outbound.location_dest ?? null,
    location_dest_id: outbound.location_dest_id ?? null,
    reference,
    barcodes: row.barcode_text
      ? [{ barcode: row.barcode_text, barcode_id: null }]
      : [],
  };
}

type SingleAdjustmentLine = {
  lot_id?: number | null;
  lot_serial?: string | null;
  qty?: number | null;
  is_original_lot?: boolean | null;
};

type SingleAdjustmentItem = {
  code?: string | null;
  name?: string | null;
  unit?: string | null;
  product_id?: number | null;
  tracking?: string | null;
  sequence?: number | null;
  barcode_text?: string | null;
  lot_id?: number | null;
  lot_serial?: string | null;
  qty?: number | null;
};

type SingleAdjustmentOutbound = {
  location?: string | null;
  location_id?: number | null;
  location_dest?: string | null;
  location_dest_id?: number | null;
};

export function buildOdooItemsForSingleAdjustment(params: {
  item: SingleAdjustmentItem;
  outbound: SingleAdjustmentOutbound;
  reference: string | null;
  linkedLines: SingleAdjustmentLine[];
}) {
  const positiveLines = params.linkedLines.filter(
    (line: SingleAdjustmentLine) =>
      Math.max(0, Math.floor(Number(line.qty ?? 0))) > 0,
  );

  return positiveLines.map((line: SingleAdjustmentLine) =>
    buildOutboundLotAdjustmentOdooItem(
      {
        qty: Math.max(0, Math.floor(Number(line.qty ?? 0))),
        code: params.item.code,
        name: params.item.name,
        unit: params.item.unit,
        lot_id: line.lot_id ?? null,
        lot_serial: line.lot_serial ?? null,
        product_id: params.item.product_id,
        tracking: params.item.tracking,
        sequence: params.item.sequence,
        barcode_text: params.item.barcode_text,
      },
      params.outbound,
      params.reference,
    ),
  );
}

export function buildOutboundLotAdjustmentOdooDedupKey(row: {
  product_id?: number | null;
  code?: string | null;
  sequence?: number | null;
  lot_id?: number | null;
  lot_serial?: string | null;
}) {
  return [
    row.product_id ?? "null",
    row.code ?? "",
    row.sequence ?? "null",
    row.lot_id ?? "null",
    normalizeLotSerialForMatch(row.lot_serial),
  ].join("|");
}

export function buildQueuedOdooFragment(params: {
  outbound: {
    no: string;
    picking_id?: number | null;
    origin?: string | null;
    location?: string | null;
    location_id?: number | null;
    location_dest?: string | null;
    location_dest_id?: number | null;
  };
  reason: string | null;
  itemsForOdoo: any[];
}) {
  return {
    params: {
      adjusts: [
        {
          no: params.outbound.no,
          picking_id: params.outbound.picking_id,
          origin: params.outbound.origin ?? params.outbound.no,
          items: params.itemsForOdoo,
        },
      ],
    },
    jsonrpc: "2.0",
  };
}

function maskSecret(value?: string | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  if (raw.length <= 8) {
    return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
  }

  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

function sha256(value?: string | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function sendQueuedOutboundLotAdjustmentsToOdoo(params: {
  outbound: {
    id: number;
    no: string;
  };
  reqOriginalUrl: string;
}) {
  const pendingAdjustments = await prisma.outbound_lot_adjustment.findMany({
    where: {
      outbound_id: params.outbound.id,
      deleted_at: null,
      status: "pending",
    },
    select: {
      id: true,
      queue_no: true,
      goods_out_item_id: true,
    },
    orderBy: [{ queue_no: "asc" }, { id: "asc" }],
  });

  if (pendingAdjustments.length === 0) {
    return {
      queued_count: 0,
      sent: false,
      skipped: true,
      reason: "no_pending_lot_adjustment",
      payload: null,
      response: null,
      error: null,
      log_id: null as number | null,
    };
  }

  const outbound = await prisma.outbound.findUnique({
    where: { id: params.outbound.id },
    select: {
      id: true,
      no: true,
      picking_id: true,
      origin: true,
      location: true,
      location_id: true,
      location_dest: true,
      location_dest_id: true,
    },
  });

  if (!outbound) {
    return {
      queued_count: pendingAdjustments.length,
      sent: false,
      skipped: true,
      reason: "outbound_not_found",
      payload: null,
      response: null,
      error: { message: `ไม่พบ outbound id=${params.outbound.id}` },
      log_id: null as number | null,
    };
  }

  const activeItems = await prisma.goods_out_item.findMany({
    where: {
      outbound_id: outbound.id,
      deleted_at: null,
    },
    select: {
      id: true,
      sequence: true,
      product_id: true,
      code: true,
      name: true,
      unit: true,
      tracking: true,
      lot_id: true,
      lot_serial: true,
      qty: true,
      barcode_text: true,
    },
    orderBy: [{ sequence: "asc" }, { id: "asc" }],
  });

  const itemsForOdoo = activeItems
    .filter((row) => Math.max(0, Math.floor(Number(row.qty ?? 0))) > 0)
    .map((row) =>
      buildOutboundLotAdjustmentOdooItem(
        {
          qty: Math.max(0, Math.floor(Number(row.qty ?? 0))),
          code: row.code,
          name: row.name,
          unit: row.unit,
          lot_id: row.lot_id,
          lot_serial: row.lot_serial,
          product_id: row.product_id,
          tracking: row.tracking,
          sequence: row.sequence,
          barcode_text: row.barcode_text,
        },
        {
          location: outbound.location,
          location_id: outbound.location_id,
          location_dest: outbound.location_dest,
          location_dest_id: outbound.location_dest_id,
        },
        "Partial lot adjustment",
      ),
    );

  const finalPayload = {
    params: {
      adjusts: [
        {
          no: outbound.no,
          items: itemsForOdoo,
          origin: outbound.origin ?? outbound.no,
          picking_id: outbound.picking_id,
        },
      ],
    },
    jsonrpc: "2.0",
  };

  if (itemsForOdoo.length === 0) {
    return {
      queued_count: pendingAdjustments.length,
      sent: false,
      skipped: true,
      reason: "empty_active_items",
      payload: finalPayload,
      response: null,
      error: { message: "ไม่มี active goods_out_item สำหรับส่ง Odoo" },
      log_id: null as number | null,
    };
  }

  const baseUrl = String(process.env.ODOO_BASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  const path = String(process.env.ODOO_OUTBOUND_UPDATE_PATH ?? "").trim();
  const ODOO_API_KEY = String(process.env.ODOO_API_KEY ?? "").trim();

  const odooUrl =
    baseUrl && path
      ? `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`
      : null;

  const requestHeaders = {
    "Content-Type": "application/json",
    "api-key": ODOO_API_KEY,
  };

  const requestHeadersForLog = {
    "Content-Type": "application/json",
    "api-key": maskSecret(ODOO_API_KEY),
  };

  const createdLog = await prisma.adjust_lot_log.create({
    data: {
      outbound_id: outbound.id,
      goods_out_item_id: null,
      outbound_no: outbound.no,
      event_name: "confirm_pick_send_full_outbound_lot_adjustment",
      request_path: params.reqOriginalUrl,
      odoo_url: odooUrl,
      request_body: finalPayload,
      request_headers: requestHeadersForLog,
      response_body: Prisma.DbNull,
      response_status: null,
      api_key_masked: maskSecret(ODOO_API_KEY),
      api_key_hash: sha256(ODOO_API_KEY),
      success: false,
      error_message: null,
      started_at: new Date(),
      completed_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    },
  });

  const logId = createdLog.id;

  if (!baseUrl || !path || !ODOO_API_KEY || !odooUrl) {
    const msg = "Skip Odoo เพราะ env ไม่ครบ";

    await prisma.adjust_lot_log.update({
      where: { id: createdLog.id },
      data: {
        response_body: Prisma.DbNull,
        response_status: null,
        success: false,
        error_message: msg,
        completed_at: new Date(),
        updated_at: new Date(),
      },
    });

    await prisma.outbound_lot_adjustment.updateMany({
      where: {
        id: { in: pendingAdjustments.map((x) => x.id) },
      },
      data: {
        send_error: msg,
      },
    });

    return {
      queued_count: pendingAdjustments.length,
      sent: false,
      skipped: false,
      reason: "env_incomplete",
      payload: finalPayload,
      response: null,
      error: { message: msg },
      log_id: logId,
    };
  }

  try {
    const resp = await axios.post(odooUrl, finalPayload, {
      headers: requestHeaders,
      timeout: 30000,
    });

    if (resp.data?.error) {
      const err = resp.data.error;

      await prisma.outbound_lot_adjustment.updateMany({
        where: {
          id: { in: pendingAdjustments.map((x) => x.id) },
        },
        data: {
          status: "failed",
          send_error: err?.message ?? JSON.stringify(err ?? null),
        },
      });

      await prisma.adjust_lot_log.update({
        where: { id: createdLog.id },
        data: {
          response_body: resp.data,
          response_status: resp.status ?? 200,
          success: false,
          error_message: err?.message ?? JSON.stringify(err ?? null),
          completed_at: new Date(),
          updated_at: new Date(),
        },
      });

      return {
        queued_count: pendingAdjustments.length,
        sent: false,
        skipped: false,
        reason: "odoo_error_response",
        payload: finalPayload,
        response: resp.data,
        error: err,
        log_id: logId,
      };
    }

    await prisma.outbound_lot_adjustment.updateMany({
      where: {
        id: { in: pendingAdjustments.map((x) => x.id) },
      },
      data: {
        status: "sent",
        sent_at: new Date(),
        send_error: null,
      },
    });

    await prisma.adjust_lot_log.update({
      where: { id: createdLog.id },
      data: {
        response_body: resp.data,
        response_status: resp.status ?? 200,
        success: true,
        error_message: null,
        completed_at: new Date(),
        updated_at: new Date(),
      },
    });

    return {
      queued_count: pendingAdjustments.length,
      sent: true,
      skipped: false,
      reason: null,
      payload: finalPayload,
      response: resp.data,
      error: null,
      log_id: logId,
    };
  } catch (error: any) {
    const err = {
      message: error?.message ?? "Unknown Odoo error",
      status: error?.response?.status ?? null,
      data: error?.response?.data ?? null,
    };

    await prisma.outbound_lot_adjustment.updateMany({
      where: {
        id: { in: pendingAdjustments.map((x) => x.id) },
      },
      data: {
        status: "failed",
        send_error:
          error?.response?.data?.error?.message ??
          error?.response?.data?.message ??
          error?.message ??
          "Unknown Odoo error",
      },
    });

    await prisma.adjust_lot_log.update({
      where: { id: createdLog.id },
      data: {
        response_body: error?.response?.data ?? Prisma.DbNull,
        response_status: error?.response?.status ?? null,
        success: false,
        error_message:
          error?.response?.data?.error?.message ??
          error?.response?.data?.message ??
          error?.message ??
          "Unknown Odoo error",
        completed_at: new Date(),
        updated_at: new Date(),
      },
    });

    return {
      queued_count: pendingAdjustments.length,
      sent: false,
      skipped: false,
      reason: "request_failed",
      payload: finalPayload,
      response: null,
      error: err,
      log_id: logId,
    };
  }
}


export function buildLotAdjustmentSignature(
  lines: Array<{
    lot_id?: number | null;
    lot_serial?: string | null;
    qty?: number | null;
  }>,
) {
  return lines
    .map((line) => ({
      lot_id: line.lot_id ?? null,
      lot_serial: normalizeLotSerialForMatch(line.lot_serial),
      qty: Math.max(0, Math.floor(Number(line.qty ?? 0))),
    }))
    .sort((a, b) => {
      const lotA = `${a.lot_id ?? "null"}|${a.lot_serial}`;
      const lotB = `${b.lot_id ?? "null"}|${b.lot_serial}`;
      return lotA.localeCompare(lotB);
    })
    .map((x) => `${x.lot_id ?? "null"}|${x.lot_serial}|${x.qty}`)
    .join("::");
}