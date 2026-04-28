import { prisma } from "../../lib/prisma";
import type { DeptMap, DeptShortMap } from "./outbound.type";

export function parseDeptOdooId(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return null;

  return n;
}

export async function buildDepartmentCodeMapFromOutbounds(
  outbounds: Array<{ department?: any }>,
): Promise<DeptMap> {
  const ids = Array.from(
    new Set(
      outbounds
        .map((o) => parseDeptOdooId((o as any).department))
        .filter((x): x is number => x != null),
    ),
  );

  const map: DeptMap = new Map();
  if (ids.length === 0) return map;

  const rows = await prisma.department.findMany({
    where: {
      deleted_at: null,
      odoo_id: { in: ids },
    } as any,
    select: {
      odoo_id: true,
      department_code: true,
    },
  });

  for (const r of rows as any[]) {
    const odooId = Number(r.odoo_id);
    const code = String(r.department_code ?? "").trim();

    if (Number.isFinite(odooId) && code) {
      map.set(odooId, code);
    }
  }

  return map;
}

export function resolveDepartmentCodeForOutbound(
  deptMap: DeptMap,
  outbound: any,
) {
  const odooId = parseDeptOdooId(outbound?.department);
  if (odooId == null) return null;

  return deptMap.get(odooId) ?? null;
}

export function parseDeptIdToInt(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export async function buildDepartmentShortNameMapFromOutbounds(
  outbounds: Array<{ department_id?: any }>,
): Promise<DeptShortMap> {
  const ids = Array.from(
    new Set(
      outbounds
        .map((o) => parseDeptIdToInt((o as any).department_id))
        .filter((x): x is number => x != null),
    ),
  );

  const map: DeptShortMap = new Map();
  if (ids.length === 0) return map;

  const rows = await prisma.department.findMany({
    where: { deleted_at: null, odoo_id: { in: ids } } as any,
    select: { odoo_id: true, short_name: true },
  });

  for (const r of rows as any[]) {
    const odooId = Number(r.odoo_id);
    const short = String(r.short_name ?? "").trim();

    if (Number.isFinite(odooId) && short) {
      map.set(odooId, short);
    }
  }

  return map;
}

export function resolveDepartmentShortNameForOutbound(
  map: DeptShortMap,
  outbound: any,
): string | null {
  const id = parseDeptIdToInt(outbound?.department_id);
  if (id == null) return null;

  return map.get(id) ?? null;
}

export async function resolveDepartmentShortNameByOdooId(
  tx: any,
  departmentOdooId: number | null | undefined,
) {
  if (typeof departmentOdooId !== "number") return null;

  const row = await tx.department.findFirst({
    where: { odoo_id: departmentOdooId },
    select: { short_name: true },
  });

  return row?.short_name ?? null;
}

export function parseDepartmentIdsAsNumbers(input: unknown): number[] {
  if (Array.isArray(input)) {
    return input
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0);
  }

  if (typeof input === "string") {
    return input
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((x) => Number.isFinite(x) && x > 0);
  }

  return [];
}