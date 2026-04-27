import { Router } from "express";
import { auth, attachDepartmentAccess } from "../middleware/auth";
import {
  createBatchOutbounds,
  getBatchOutbounds,
  getMyBatchOutbounds,
  releaseBatchOutbounds,
  deleteBatchOutboundsByName,
  getMyBatchOutboundGroups,
  deleteBatchOutboundsByOutboundId,
} from "../controllers/batch_outbound.controller";

const router = Router();

router.post("/create", auth, createBatchOutbounds);
router.get("/get", auth, getBatchOutbounds);
router.get("/get/my", auth, getMyBatchOutbounds);
router.get("/get/groups", auth, attachDepartmentAccess, getMyBatchOutboundGroups);
router.patch("/release", auth, releaseBatchOutbounds);
router.delete("/delete/:name", auth, deleteBatchOutboundsByName);
router.delete(
  "/delete/outboundId/:outbound_id",
  auth,
  deleteBatchOutboundsByOutboundId,
);

export default router;
