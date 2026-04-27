import type { Request } from "express";
import { badRequest } from "./appError";

export function getUserId(req: Request): number {
  const fromReqUser = (req as any).user?.id;
  const fromBody = (req.body as any)?.user_id;

  const id = Number(fromReqUser ?? fromBody);
  if (!Number.isFinite(id)) {
    throw badRequest("ไม่พบ user_id (ต้อง login หรือส่ง user_id มา)", {
      field: "user_id",
    });
  }

  return id;
}
