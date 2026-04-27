import { Router } from "express";
import { uploadLocationFile } from "../middleware/upload";
//import { auth } from "../middleware/auth";
import {
  createLocation,
  getLocations,
  getLocationsPaginated,
  getLocationById,
  updateLocation,
  deleteLocation,
  getLocationsBorBosSer,
} from "../controllers/location.controller";

const router = Router();

router.post("/create", uploadLocationFile, createLocation);
router.get("/getAll", getLocations);
router.get("/get", getLocationsPaginated);
router.get("/get/bor", getLocationsBorBosSer);
router.get("/get/:id", getLocationById);
router.patch("/update/:id", uploadLocationFile, updateLocation);
router.delete("/delete/:id", deleteLocation);

export default router;
