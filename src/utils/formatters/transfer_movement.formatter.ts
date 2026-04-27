import type {
  transfer_movement,
  transfer_movement_item,
  user,
  department,
  transfer_movement_department,
  transfer_movement_user_work,
  transfer_movement_item_location_put_confirm,
  location,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";

export type AttachBarcodePayload = {
  barcodeTextMap: Map<string, string | null>;
  inputNumberMap?: Map<number, boolean>;
  userWorkMap?: Map<
    number,
    {
      id: number;
      first_name: string;
      last_name: string;
      tel: string | null;
      user_level: string | null;
    }
  >;
};

type MovementPutConfirmWithLocation = transfer_movement_item_location_put_confirm & {
  location?: location | null;
};

type TransferMovementItemWithPutLocations = transfer_movement_item & {
  transferMovementItemLocationPutConfirms?: MovementPutConfirmWithLocation[];
};

export async function buildInputNumberMap(items: transfer_movement_item[]) {
  const ids = Array.from(
    new Set(
      items
        .map((i) => i.product_id)
        .filter((v): v is number => typeof v === "number"),
    ),
  );

  const rows = await prisma.wms_mdt_goods.findMany({
    where: { product_id: { in: ids } },
    select: { product_id: true, input_number: true, id: true },
    orderBy: { id: "desc" },
  });

  const map = new Map<number, boolean>();
  for (const r of rows) {
    if (!map.has(r.product_id)) {
      map.set(r.product_id, Boolean(r.input_number));
    }
  }
  return map;
}

function normalizeLotText(v: unknown): string {
  const s = v == null ? "" : String(v).trim();
  const n = s.replace(/\s+/g, " ").toLowerCase();
  return n.length ? n : "__NULL__";
}

function movementGoodsKey(product_id: number, lot_serial: unknown) {
  return `p:${product_id}|lot:${normalizeLotText(lot_serial)}`;
}

function formatPutLocations(
  item: TransferMovementItemWithPutLocations,
): Array<{
  id: number;
  location_id: number;
  location_name: string | null;
  confirmed_put: number;
}> {
  const rows = Array.isArray(item.transferMovementItemLocationPutConfirms)
    ? item.transferMovementItemLocationPutConfirms
    : [];

  return rows
    .map((r) => {
      const qty = Math.max(0, Number(r.confirmed_put ?? 0));
      if (qty <= 0) return null;

      return {
        id: r.id,
        location_id: r.location_id,
        location_name: r.location?.full_name ?? null,
        confirmed_put: qty,
      };
    })
    .filter(Boolean) as Array<{
    id: number;
    location_id: number;
    location_name: string | null;
    confirmed_put: number;
  }>;
}

export function formatTransferMovement(
  doc: transfer_movement & {
    user: user;
    department: department;
    items?: TransferMovementItemWithPutLocations[];

    movement_departments?: Array<
      transfer_movement_department & { department: department }
    >;
    movement_user_works?: Array<
      transfer_movement_user_work & { user: user }
    >;
  },
  payload?: AttachBarcodePayload,
) {
  const md = Array.isArray((doc as any).movement_departments)
    ? (doc as any).movement_departments
    : [];

  const mu = Array.isArray((doc as any).movement_user_works)
    ? (doc as any).movement_user_works
    : [];

  const departments = md
    .map((x: any) => x?.department)
    .filter(Boolean)
    .map((d: any) => ({
      id: d.id,
      full_name: d.full_name,
      short_name: d.short_name,
    }));

  const user_works = mu
    .map((x: any) => x?.user)
    .filter(Boolean)
    .map((u: any) => ({
      id: u.id,
      first_name: u.first_name,
      last_name: u.last_name,
      user_level: u.user_level ?? null,
    }));

  const uwId = Number((doc as any).user_work_id ?? NaN);
  const user_work =
    Number.isFinite(uwId) && uwId > 0
      ? payload?.userWorkMap?.get(uwId) ??
        user_works.find((u: any) => u.id === uwId) ??
        null
      : null;

  return {
    id: doc.id,
    no: doc.no,
    status: doc.status,

    departments,

    user: {
      id: doc.user.id,
      first_name: doc.user.first_name,
      last_name: doc.user.last_name,
      user_level: doc.user.user_level,
    },

    user_works,
    user_work,

    created_at: doc.created_at.toISOString(),
    updated_at: doc.updated_at ? doc.updated_at.toISOString() : null,

    items: (doc.items ?? [])
      .filter((it) => !(it as any).deleted_at)
      .sort(
        (a, b) =>
          Number((a as any).sequence ?? 0) - Number((b as any).sequence ?? 0),
      )
      .map((it: any) => {
        const pidFromItem = Number(it.product_id ?? NaN);
        const pidFromCode = Number(String(it.code ?? "").trim());
        const pid =
          Number.isFinite(pidFromItem) && pidFromItem > 0
            ? pidFromItem
            : pidFromCode;

        const k =
          Number.isFinite(pid) && pid > 0
            ? movementGoodsKey(pid, it.lot_serial)
            : "";

        const barcode_text = k
          ? payload?.barcodeTextMap.get(k) ?? null
          : null;

        const input_number =
          it.product_id != null
            ? payload?.inputNumberMap?.get(it.product_id) ?? false
            : false;

        const lock_no_dest_list = formatPutLocations(it);
        const lock_no_dest_summary = lock_no_dest_list
          .map((x) => `${x.location_name} (${x.confirmed_put})`)
          .join(", ");

        const qty_put_from_locations = lock_no_dest_list.reduce(
          (sum, x) => sum + Number(x.confirmed_put ?? 0),
          0,
        );

        return {
          id: it.id,
          sequence: it.sequence ?? null,
          product_id: it.product_id ?? null,
          code: it.code ?? null,
          name: it.name,
          lock_no: it.lock_no ?? null,

          lock_no_dest:
            lock_no_dest_summary || it.lock_no_dest || null,
          lock_no_dest_list,

          lot_serial: it.lot_serial ?? null,
          unit: it.unit,
          exp: it.exp ? it.exp.toISOString() : null,
          qty: it.qty ?? null,
          qty_pick: it.qty_pick ?? null,
          qty_put:
            qty_put_from_locations > 0
              ? qty_put_from_locations
              : (it.qty_put ?? null),

          barcode_text,
          input_number,

          status: it.status ?? "pick",
          created_at: it.created_at ? it.created_at.toISOString() : null,
          updated_at: it.updated_at ? it.updated_at.toISOString() : null,
        };
      }),
  };
}