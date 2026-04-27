import { Router } from "express";
//import { auth } from "../middleware/auth";
import {
  createZone,
  getZones,
  getZonesPaginated,
  getZoneById,
  updateZone,
  deleteZone,
} from "../controllers/zone.controller";

const router = Router();

router.post("/create", createZone);
router.get("/getAll", getZones);
router.get("/get", getZonesPaginated);
router.get("/get/:id", getZoneById);
router.patch("/update/:id", updateZone);
router.delete("/delete/:id", deleteZone);

export default router;
