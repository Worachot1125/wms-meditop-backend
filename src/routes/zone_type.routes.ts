import { Router } from "express";
//import { auth } from "../middleware/auth";
import {
  manualSyncZoneTypes,
  createZoneType,
  getZoneTypes,
  getZoneTypesPaginated,
  getZoneTypeById,
  updateZoneType,
  deleteZoneType,
} from "../controllers/zone_type.controller";

const router = Router();

router.post("/sync", manualSyncZoneTypes);  // Manual sync from Odoo
router.post("/create", createZoneType);
router.get("/getAll", getZoneTypes);
router.get("/get", getZoneTypesPaginated);
router.get("/get/:id", getZoneTypeById);
router.patch("/update/:id", updateZoneType);
router.delete("/delete/:id", deleteZoneType);

export default router;
