import { Prisma } from "@prisma/client";

function formatYYMMDD(d: Date) {
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`; // 260216
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
function startOfNextDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
}

export async function generateBatchPickName(
  tx: Prisma.TransactionClient,
  now = new Date(),
) {
  const datePart = formatYYMMDD(now);
  const prefix = `PICK_${datePart}_`;

  const dayStart = startOfDay(now);
  const dayEnd = startOfNextDay(now);

  const latest = await tx.batch_outbound.findFirst({
    where: {
      created_at: { gte: dayStart, lt: dayEnd }, // ✅ วันเดียวกันจริง ๆ
      name: { startsWith: prefix },
    },
    select: { name: true },
    orderBy: { name: "desc" }, // PICK_260216_010 > PICK_260216_009
  });

  let nextSeq = 1;
  if (latest?.name) {
    const m = latest.name.match(/_(\d{3})$/);
    const last = m ? Number(m[1]) : 0;
    nextSeq = Number.isFinite(last) ? last + 1 : 1;
  }

  const seq = String(nextSeq).padStart(3, "0");
  return `${prefix}${seq}`; // PICK_260216_001
}

