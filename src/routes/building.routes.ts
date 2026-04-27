import { Router } from "express";
//import { auth } from "../middleware/auth";
import {
  createBuilding,
  getBuildings,
  getBuildingsPaginated,
  getBuildingById,
  updateBuilding,
  deleteBuilding,
} from "../controllers/building.controller";

const router = Router();

router.post("/create", createBuilding);
router.get("/getAll", getBuildings);
router.get("/get", getBuildingsPaginated);
router.get("/get/:id", getBuildingById);
router.patch("/update/:id", updateBuilding);
router.delete("/delete/:id", deleteBuilding);

export default router;
