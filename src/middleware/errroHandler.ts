import type { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/appError";

// แปลงชื่อ column ให้คนอ่านรู้เรื่อง (fallback)
function humanizeField(field?: string) {
  if (!field) return "ข้อมูล";

  return field.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// แปลง Prisma error → HTTP error
function prismaToHttp(err: any): AppError | null {
  const code = err?.code;

  // UNIQUE constraint
  if (code === "P2002") {
    const field: string | undefined = err?.meta?.target?.[0];

    const message = `${humanizeField(field)} นี้ถูกใช้แล้ว`;

    return new AppError(409, message, {
      code: "DUPLICATE",
      field,
    });
  }

  // Record not found
  if (code === "P2025") {
    return new AppError(404, "ไม่พบข้อมูล", {
      code: "NOT_FOUND",
    });
  }

  // Foreign key constraint
  if (code === "P2003") {
    return new AppError(409, "อ้างอิงข้อมูลไม่ถูกต้อง", {
      code: "FK_CONFLICT",
    });
  }

  return null;
}

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  // 1) Prisma error
  const prismaErr = prismaToHttp(err);
  if (prismaErr) {
    return res.status(prismaErr.statusCode).json({
      message: prismaErr.message,
      code: prismaErr.code,
      field: prismaErr.field,
    });
  }

  // 2) AppError
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      message: err.message,
      code: err.code,
      field: err.field,
      details: err.details,
    });
  }

  // 3) 500 จริง (สิ่งที่คุณต้องการ)
  return res.status(500).json({
    message: err?.message || "เกิดข้อผิดพลาดภายในระบบ",
    code: "INTERNAL_SERVER_ERROR",
  });
}
