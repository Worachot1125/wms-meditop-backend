import { Request, Response, NextFunction } from "express";
import { verifyToken, JwtEmployeePayload } from "../lib/jwt";
import { logger } from "../lib/logger";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

type AuthUser = {
  id: number;
  user_level?: string | null;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

type DepartmentAccess = {
  isPrivileged: boolean;
  allowedDepartmentIds: string[];
  allowedLocalDepartmentIds?: number[];
};

export type AuthRequest = Request & {
  employee?: JwtEmployeePayload;
  user?: AuthUser;
  departmentAccess?: DepartmentAccess;
};

export const auth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const token = authHeader.split(" ")[1];
    const payload = verifyToken(token);

    req.employee = payload;

    // ✅ ดึง user จาก DB ตรงนี้เลย
    const user = await prisma.user.findUnique({
      where: { id: payload.empId },
      select: {
        id: true,
        user_level: true,
        username: true,
        first_name: true,
        last_name: true,
      },
    });

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    req.user = user;

    next();
  } catch (err) {
    logger.warn("auth error (invalid/expired token)");
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

/**
 * Middleware เช็คสิทธิ์สำหรับการ Overwrite Stock Count
 * - Admin: อนุญาต
 * - Supervisor: อนุญาต
 * - Operator: ไม่อนุญาต ❌
 */
export const checkOverwritePermission = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const empId = req.employee?.empId;

    if (!empId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // ดึงข้อมูล user จาก database
    const user = await prisma.user.findUnique({
      where: { id: empId },
      select: {
        id: true,
        user_level: true,
        username: true,
        first_name: true,
        last_name: true,
      },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // เก็บข้อมูล user ไว้ใน request
    req.user = user;

    // เช็คสิทธิ์: Operator ไม่สามารถ overwrite ได้
    if (user.user_level === "Operator") {
      logger.warn(
        `Operator (${user.username}) attempted to overwrite stock count`,
      );
      return res.status(403).json({
        message: "You don't have permission to overwrite stock count",
        code: "FORBIDDEN",
      });
    }

    // Admin, Supervisor, UAT สามารถ overwrite ได้
    next();
  } catch (err) {
    logger.error("checkOverwritePermission error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const denyOperatorCreateTransferMovement = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const user = req.user;

  // auth ต้อง run มาก่อน
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  if (user.user_level === "Operator") {
    logger.warn(
      `Operator (${user.username}) attempted to create transfer movement`,
    );
    return res.status(403).json({
      message: "You don't have permission to create transfer movement",
      code: "FORBIDDEN",
    });
  }

  return next();
};

/* =========================================================
 * ✅ NEW: Department Access Helpers / Middleware
 * ใช้ซ้ำได้หลาย controller
 * ========================================================= */

function isPrivilegedUser(userLevel: string | null | undefined) {
  return ["Admin", "Supervisor", "UAT"].includes(String(userLevel ?? ""));
}

/**
 * โหลดสิทธิ์แผนกของ user แล้วเก็บไว้ใน req.departmentAccess
 * - Admin / Supervisor / UAT => isPrivileged = true
 * - role อื่น => โหลดแผนกจาก user_department
 */
export const attachDepartmentAccess = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const privileged = isPrivilegedUser(user.user_level);

    if (privileged) {
      req.departmentAccess = {
        isPrivileged: true,
        allowedDepartmentIds: [],
        allowedLocalDepartmentIds: [],
      };
      return next();
    }

    const rows = await prisma.user_department.findMany({
      where: {
        user_id: user.id,
      },
      select: {
        department_id: true,
        department: {
          select: {
            id: true,
            odoo_id: true,
            short_name: true,
            full_name: true,
          },
        },
      },
    });

    // ✅ ถ้าผูกกับแผนก CNE ให้เห็นทุกแผนก
    const hasCNE = rows.some(
      (row) => String(row.department?.short_name ?? "").trim().toUpperCase() === "CNE",
    );

    if (hasCNE) {
      req.departmentAccess = {
        isPrivileged: true,
        allowedDepartmentIds: [],
        allowedLocalDepartmentIds: [],
      };
      return next();
    }

    const allowedDepartmentIds = rows
      .map((row) => row.department?.odoo_id)
      .filter((v): v is number => v !== null && v !== undefined)
      .map((v) => String(v));

    const allowedLocalDepartmentIds = rows
      .map((row) => row.department_id)
      .filter((v): v is number => v !== null && v !== undefined);

    req.departmentAccess = {
      isPrivileged: false,
      allowedDepartmentIds,
      allowedLocalDepartmentIds,
    };

    return next();
  } catch (err) {
    logger.error("attachDepartmentAccess error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * helper สำหรับ controller:
 * สร้าง where เฉพาะ department จาก req.departmentAccess
 *
 * รองรับ query ?department_id=...
 * - privileged: filter ได้ทุก department
 * - non-privileged: filter ได้เฉพาะแผนกที่ตัวเองมีสิทธิ์
 */
export const buildDepartmentAccessWhere = (
  req: AuthRequest,
): { department_id?: string | { in: string[] } } => {
  const access = req.departmentAccess;
  const requestedDepartmentId =
    typeof req.query.department_id === "string"
      ? req.query.department_id.trim()
      : "";

  if (!access) {
    throw new Error(
      "departmentAccess is missing. Please use attachDepartmentAccess middleware before controller.",
    );
  }

  if (access.isPrivileged) {
    if (requestedDepartmentId) {
      return { department_id: requestedDepartmentId };
    }
    return {};
  }

  if (access.allowedDepartmentIds.length === 0) {
    return { department_id: { in: [] } };
  }

  if (requestedDepartmentId) {
    if (!access.allowedDepartmentIds.includes(requestedDepartmentId)) {
      return { department_id: { in: [] } };
    }
    return { department_id: requestedDepartmentId };
  }

  return {
    department_id: { in: access.allowedDepartmentIds },
  };
};

export const buildLocalDepartmentAccessWhere = (
  req: AuthRequest,
): { department_id?: number | { in: number[] } } => {
  const access = req.departmentAccess;

  if (!access) {
    console.error("buildLocalDepartmentAccessWhere: req.departmentAccess missing");
    console.error("req.user =>", req.user);
    throw new Error(
      "departmentAccess is missing. Please use attachDepartmentAccess middleware before controller.",
    );
  }

  const requestedDepartmentIdRaw =
    typeof req.query.department_id === "string"
      ? req.query.department_id.trim()
      : "";

  const requestedDepartmentId = requestedDepartmentIdRaw
    ? Number(requestedDepartmentIdRaw)
    : null;

  if (access.isPrivileged) {
    if (
      requestedDepartmentId !== null &&
      Number.isFinite(requestedDepartmentId)
    ) {
      return { department_id: requestedDepartmentId };
    }
    return {};
  }

  const allowedLocalDepartmentIds = access.allowedLocalDepartmentIds ?? [];

  if (allowedLocalDepartmentIds.length === 0) {
    return { department_id: { in: [] } };
  }

  if (requestedDepartmentIdRaw) {
    if (!Number.isFinite(requestedDepartmentId)) {
      return { department_id: { in: [] } };
    }

    if (!allowedLocalDepartmentIds.includes(requestedDepartmentId!)) {
      return { department_id: { in: [] } };
    }

    return { department_id: requestedDepartmentId! };
  }

  return {
    department_id: { in: allowedLocalDepartmentIds },
  };
};

// transfer_movement
export function buildTransferMovementDepartmentAccessWhere(
  req: AuthRequest,
): Prisma.transfer_movementWhereInput {
  const access = req.departmentAccess;

  if (!access) {
    throw  new Error (
      "departmentAccess is missing. Please use attachDepartmentAccess middleware before controller.",
    );
  }

  const requestedDepartmentIdRaw =
    typeof req.query.department_id === "string"
      ? req.query.department_id.trim()
      : "";

  const requestedDepartmentId = requestedDepartmentIdRaw
    ? Number(requestedDepartmentIdRaw)
    : null;

  // Admin / Supervisor / UAT
  if (access.isPrivileged) {
    if (
      requestedDepartmentId !== null &&
      Number.isFinite(requestedDepartmentId)
    ) {
      return {
        OR: [
          { department_id: requestedDepartmentId },
          {
            movement_departments: {
              some: { department_id: requestedDepartmentId },
            },
          },
        ],
      };
    }

    return {};
  }

  const allowedIds = access.allowedLocalDepartmentIds ?? [];

  if (allowedIds.length === 0) {
    return {
      department_id: { in: [] },
    };
  }

  if (requestedDepartmentIdRaw) {
    if (!Number.isFinite(requestedDepartmentId)) {
      return {
        department_id: { in: [] },
      };
    }

    if (!allowedIds.includes(requestedDepartmentId!)) {
      return {
        department_id: { in: [] },
      };
    }

    return {
      OR: [
        { department_id: requestedDepartmentId! },
        {
          movement_departments: {
            some: { department_id: requestedDepartmentId! },
          },
        },
      ],
    };
  }

  return {
    OR: [
      { department_id: { in: allowedIds } },
      {
        movement_departments: {
          some: {
            department_id: { in: allowedIds },
          },
        },
      },
    ],
  };
}

// Create Update Uer AdminOnly
export const allowAdminOnly = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  if (user.user_level !== "Admin") {
    logger.warn(
      `Non-admin (${user.username ?? user.id}) attempted admin-only action`,
    );
    return res.status(403).json({
      message: "Only Admin can perform this action",
      code: "FORBIDDEN",
    });
  }

  return next();
};