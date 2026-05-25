import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

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

function getBorrowMovementQty(type: string, qty: number) {
  if (type === "return" || type === "adjust_in") {
    return { in_qty: qty, out_qty: 0, net_qty: qty };
  }

  return { in_qty: 0, out_qty: qty, net_qty: -qty };
}

export class BorrowStockDailyService {
  async createDailySnapshot(triggeredBy = "system", date?: string) {
    const target = date
      ? toStartOfDay(new Date(date))
      : toStartOfDay(new Date());
    const nextDay = addDays(target, 1);
    const snapshot_date = target.toISOString().split("T")[0];

    logger.info("📸 Refreshing borrow stock daily movement...", {
      triggeredBy,
      snapshot_date,
    });

    const rows = await prisma.borrow_stock.findMany({
      where: {
        deleted_at: null,
        status: "completed",
        updated_at: {
          gte: target,
          lt: nextDay,
        },
      },
      include: {
        department: true,
        borrowStockItems: {
          where: {
            deleted_at: null,
          },
        },
      },
      orderBy: {
        id: "asc",
      },
    });

    await prisma.$transaction(async (tx) => {
      await tx.borrow_stock_daily.deleteMany({
        where: {
          snapshot_date: {
            gte: target,
            lt: nextDay,
          },
        },
      });

      const data = rows.flatMap((doc) =>
        doc.borrowStockItems.map((item) => {
          const qty = Number(item.executed_qty ?? 0);
          const m = getBorrowMovementQty(
            (doc as any).movement_type ?? "borrow",
            qty,
          );

          return {
            snapshot_date: target,

            borrow_stock_id: doc.id,
            item_id: item.id,

            department_id: doc.department_id ?? null,
            department_name: doc.department?.short_name ?? null,

            location_name: doc.location_name,

            product_code: item.code,
            product_name: item.name ?? null,
            lot_serial: item.lot_serial,
            expiration_date: item.expiration_date ?? null,

            in_qty: m.in_qty,
            out_qty: m.out_qty,
            net_qty: m.net_qty,

            status: doc.status,
            user_ref: doc.user_ref ?? null,
            remark: doc.remark ?? null,
          };
        }),
      );

      if (data.length > 0) {
        await tx.borrow_stock_daily.createMany({ data });
      }
    });

    const total_snapshot = await prisma.borrow_stock_daily.count({
      where: {
        snapshot_date: {
          gte: target,
          lt: nextDay,
        },
      },
    });

    return {
      success: true,
      snapshot_date,
      total_snapshot,
      errors: [],
    };
  }
}

export const borrowStockDailyService = new BorrowStockDailyService();
