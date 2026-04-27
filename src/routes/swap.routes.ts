import { Router } from "express";
import { auth, attachDepartmentAccess } from "../middleware/auth"
import {
getSwaps,
getSwapsPaginated,
getSwapByNo,
} from "../controllers/swap.controller";

const router = Router();

router.get("/getAll", getSwaps);
router.get("/get", auth, attachDepartmentAccess, getSwapsPaginated);
router.get("/get/:no", getSwapByNo);

export default router;
