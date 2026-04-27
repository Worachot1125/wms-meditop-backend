import { Router } from "express";
import {
	listCombinedAdjustments,
	getAdjustmentDetail,
	processAdjustment,
	confirmAdjustment,
	cancelAdjustment,
	receiveOdooAdjustments,
	confirmAdjustmentCompleteByNo,
	saveAdjustmentDraft,
	scanAdjustmentLocation,
	scanAdjustmentBarcode,
	deleteAdjustmentItem,
} from "../controllers/adjust.controller";

const router = Router();

router.get("/", listCombinedAdjustments);
router.get("/:id", getAdjustmentDetail);
router.post("/:id/process", processAdjustment);
router.post("/:id/confirm", confirmAdjustment);
router.post("/:id/cancel", cancelAdjustment);
router.delete(":id/items/:itemId", deleteAdjustmentItem);

// POST for Odoo
router.post("/odoo", receiveOdooAdjustments);
router.post("/:no/scan/location", scanAdjustmentLocation);
router.post("/:no/scan/barcode", scanAdjustmentBarcode);
router.post("/:no/draft", saveAdjustmentDraft);
router.post("/:no/complete", confirmAdjustmentCompleteByNo);

export default router;

