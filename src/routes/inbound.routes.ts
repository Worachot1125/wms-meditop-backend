import { Router } from "express";
import { auth, attachDepartmentAccess } from "../middleware/auth";
import {
  createInbound,
  deleteInbound,
  getInboundByGr,
  getInbounds,
  getInboundsPaginated,
  updateInbound,
} from "../controllers/inbound.controller";
import {
  receiveFromOdoo,
  getOdooInbounds,
  getOdooInboundByNo,
  getOdooInboundByNoPaginated,
  updateOdooInbound,
  deleteOdooInbound,
} from "../controllers/inbound.odoo.controller";
import {
  scanInboundLocation,
  scanInboundBarcode,
  confirmInboundToStock,
  undoScanInboundBarcode,
} from "../controllers/inbound.scan.controller";

const router = Router();

router.post("/create", createInbound);
router.get("/getAll", auth, attachDepartmentAccess, getInbounds);
router.get("/get", auth, attachDepartmentAccess, getInboundsPaginated);
router.get("/get/:gr", getInboundByGr);
router.patch("/update/:gr", updateInbound);
router.delete("/delete/:gr", deleteInbound);

// Odoo Integration
router.post("/create/odoo/transfers", receiveFromOdoo);
router.get("/get/odoo/transfers", getOdooInbounds);
router.get("/get/odoo/transfers/:no", getOdooInboundByNo);
router.get("/get/odoo/transfers/:no/paginated", getOdooInboundByNoPaginated);
router.patch("/update/odoo/transfers/:no", updateOdooInbound);
router.delete("/delete/odoo/transfers/:no", deleteOdooInbound);

/**
 * 1) Scan location อย่างเดียว (เอา location_id/location_name)
 * POST /api/inbounds/:no/scan/location
 * body: { location_full_name: string }
 */
router.post("/:no/scan/location", scanInboundLocation);

/**
 * 2) Scan barcode (เพิ่ม qty_count ให้ goods_in)
 * POST /api/inbounds/:no/scan/barcode
 * body: { barcode: string; location_full_name: string; qty_input?: number }
 */
router.post("/:no/scan/barcode", scanInboundBarcode);
router.post("/:no/scan/undo", undoScanInboundBarcode);

/**
 * 3) Confirm -> upsert เข้า stocks
 * POST /api/inbounds/:no/scan/confirm
 * body: { location_full_name: string }
 */
router.post("/:no/scan/confirm", confirmInboundToStock);

export default router;
