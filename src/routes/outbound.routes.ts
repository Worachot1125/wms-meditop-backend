import { Router } from "express";
import { auth, attachDepartmentAccess } from "../middleware/auth";
import {
  receiveOutboundFromOdoo,
  getOdooOutbounds,
  getOdooOutboundByNo,
  updateOdooOutbound,
  deleteOdooOutbound,
  createOrUpdateOutboundItemBarcode,
  removeOutboundItemBarcode,
  createOrUpdateOutboundBarcode,
  getOutboundByBarcode,
  addItemToOutbound,
  updateOutboundItem,
  getOutboundItem,
  searchOutboundsByItem,
  bulkDeleteOutbounds,
  getPackedOutboundItems,
  getOdooOutboundsByMyBatch,
  getOdooOutboundsAvailable,
  getOdooOutboundsByBatchName,
  getSpecialOutbounds,
  getSpecialOutboundById,
  createOutboundLotAdjustment,
  revertOutboundLotAdjustment,
  updateGoodsOutItemRtc,
  scanOutboundItemCheckBarcode,
  getAutoLocationPackCandidates,
  applyAutoLocationPack,
  getOdooOutboundsInProcess,
  getOdooOutboundsWaitReturnPack,
  scanReversePackingDoc,
  confirmReversePackingDocs,
} from "../controllers/outbound.odoo.controller";

import {
  scanOutboundLocation,
  scanOutboundExpNcrLocation,
  scanOutboundPick,
  scanOutboundPickNcr,
  confirmOutboundPickToStock,
  scanOutboundReturn,
  scanBarcodeOutboundReturn,
  confirmOutboundReturn,
  scanOutboundRtcReturnPick,
  confirmRTCtoStock,
} from "../controllers/outbound.scan.controller";
import {
  scanPackProductBarcode,
  getPackProductById,
  scanPackProductItem,
  removePackProductBoxItem,
  scanPackProductItemReturn,
  getPackProductByPrefix,
  finalizePackProduct,
  getPackProductSummary,
  getPackProducts,
  movePdPackingToLocation,
  moveRtcPackingToLocation,
  returnPdPackProductItem,
  closeBangkokPackBox,
  createBangkokPackProduct,
  getLatestPackProduct,
  validateBangkokPackDoc,
  scanTransportBKKBarcode,
  scanReceiveNoPackDoc,
  confirmReceiveNoPackDocs,
} from "../controllers/pack_product.controller";

const router = Router();

// Odoo Integration - Outbound
router.post("/create/odoo/transfers", receiveOutboundFromOdoo);
router.get("/get/odoo/transfers", getOdooOutbounds);
router.get("/get/adjust", getSpecialOutbounds);
router.get("/get/adjust/:id", getSpecialOutboundById);
router.get("/get/odoo/transfers/user", auth, getOdooOutboundsByMyBatch);
router.get(
  "/get/odoo/transfers/user/:name",
  auth,
  attachDepartmentAccess,
  getOdooOutboundsByBatchName,
);
router.get(
  "/get/odoo/transfers/available",
  auth,
  attachDepartmentAccess,
  getOdooOutboundsAvailable,
);
router.get(
  "/get/odoo/transfers/completed",
  auth,
  attachDepartmentAccess,
  getOdooOutboundsInProcess,
);
router.get(
  "/get/odoo/transfers/return",
  auth,
  attachDepartmentAccess,
  getOdooOutboundsWaitReturnPack,
);
router.get("/get/odoo/transfers/:no", getOdooOutboundByNo);
router.patch("/update/odoo/transfers/:no", updateOdooOutbound);

// Search Outbounds by Item (ต้องอยู่ก่อน /:no/items)
router.get("/get/search", searchOutboundsByItem);

// Get Packed Items (สินค้าที่ pack แล้วและมี box)
router.get("/packed-items", getPackedOutboundItems);

// Add Item to Outbound
router.post("/:no/itscanOutboundItemCheckBarcodeems", addItemToOutbound);
router.get("/:no/items/:itemId", getOutboundItem);
router.post("/:no/items/:itemId/check", scanOutboundItemCheckBarcode);
router.post("/:no/items/:itemId/lot", createOutboundLotAdjustment);
router.patch("/:no/items/:itemId", updateOutboundItem);
router.patch("/update/rtc/:id", updateGoodsOutItemRtc);
// list
router.get("/pack-products", getPackProducts);
router.get("/pack-products/latest", getLatestPackProduct);
router.get("/pack-products/by-prefix/:prefix", getPackProductByPrefix);
router.post(
  "/pack-products/:packProductId/pd/move-to-pack-location",
  movePdPackingToLocation,
);

router.post(
  "/pack-products/rtc-bor/move-to-location",
  moveRtcPackingToLocation,
);
router.post(
  "/auto-location-pack/candidates",
  getAutoLocationPackCandidates,
);

router.post(
  "/auto-location-pack/apply",
  applyAutoLocationPack,
);
// summary ต้องมาก่อน :id ถ้าใช้ pattern นี้
router.get("/pack-products/:packProductId/summary", getPackProductSummary);
router.get("/pack-products/:id", getPackProductById);
router.post("/pack-products/scan", scanPackProductBarcode);
router.post("/pack-products/transport/scan", scanTransportBKKBarcode);
router.post("/pack-products/bangkok/validate-doc", validateBangkokPackDoc);
router.post("/pack-products/bangkok", createBangkokPackProduct);
router.post(
  "/pack-products/:packProductId/boxes/:boxId/close-bangkok",
  closeBangkokPackBox,
);
router.post(
  "/pack-products/:packProductId/pd/return-item",
  returnPdPackProductItem,
);
router.post(
  "/pack-products/:packProductId/boxes/:boxId/scan-item",
  scanPackProductItem,
);
router.post(
  "/pack-products/:packProductId/boxes/:boxId/scan-return",
  scanPackProductItemReturn,
);
router.delete(
  "/:no/items/:itemId/lot/:adjustmentId",
  revertOutboundLotAdjustment,
);

router.delete("/delete/odoo/transfers/:no", deleteOdooOutbound);

// Bulk Delete Outbounds
router.post("/bulk-delete", bulkDeleteOutbounds);

//revert pack | no pack
router.post("/no-packing/reverse/scan", scanReversePackingDoc);
router.post("/no-packing/reverse/confirm", confirmReversePackingDocs);
router.post("/no-packing/receive/scan", scanReceiveNoPackDoc);
router.post("/no-packing/receive/confirm", confirmReceiveNoPackDocs);

// Barcode Management for Outbound
router.post(
  "/create/odoo/transfers/:no/barcode",
  createOrUpdateOutboundBarcode,
);
router.get("/get/odoo/barcode/:barcode", getOutboundByBarcode);

// Barcode Management for Outbound Items
router.post(
  "/create/odoo/transfers/:no/items/:itemId/barcode",
  createOrUpdateOutboundItemBarcode,
);
router.delete(
  "/delete/odoo/transfers/:no/items/:itemId/barcode",
  removeOutboundItemBarcode,
);

router.post("/pack-products/:packProductId/finalize", finalizePackProduct);

router.delete(
  "/pack-products/:packProductId/boxes/:boxId/items/:packBoxItemId",
  removePackProductBoxItem,
);

// 1) Scan Location
// POST /api/outbounds/:no/scan/location
router.post("/:no/scan/location", scanOutboundLocation);
router.post("/:no/scan/location/ncr", scanOutboundExpNcrLocation);

// 2) Scan Pick (preview)
// POST /api/outbounds/:no/scan/barcode
router.post("/:no/scan/barcode", scanOutboundPick);
router.post("/:no/scan/barcode/ncr", scanOutboundPickNcr);
router.post("/:no/scan/return", scanOutboundReturn);
router.post("/:no/scan/barcode/return", scanBarcodeOutboundReturn);
router.post("/:no/scan/barcode/return-pick", scanOutboundRtcReturnPick);

// 3) Confirm Pick -> Decrement Stock (DELTA)
// POST /api/outbounds/:no/scan/confirm
router.post("/:no/scan/confirm", confirmOutboundPickToStock);
router.post("/:no/scan/confirm/return", confirmOutboundReturn);
router.post("/:no/confirm-rtc-to-stock", confirmRTCtoStock);

export default router;
