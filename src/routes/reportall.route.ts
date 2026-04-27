import { Router } from "express";
import {
  getTransactionReportDetail,
} from "../controllers/detail.all.controller";

const router = Router();


// ✅ detail ของแต่ละเอกสาร
router.get("/:source/:id", getTransactionReportDetail);

export default router;