import { Router } from "express";
import { auth, attachDepartmentAccess } from "../middleware/auth";
import {
  createTransferDoc,
  getTransferDocs,
  getTransferDocsPaginated,
  getTransferDocByNo,
  updateTransferDoc,
  deleteTransferDoc,
} from "../controllers/transfer.controller";
import {
  getOdooTransferDocs,
  getOdooTransferDocByNoPaginated,
  getOdooTransferDocByNo,
  updateOdooTransferDoc,
  deleteOdooTransferDoc,
} from "../controllers/transfer.odoo.controller";

import {
    createTransferDocItem,
    getTransferDocItems,
    getTransferDocItemsPaginated,
    getTransferDocItemById,
    updateTransferDocItem,
    deleteTransferDocItem,
} from "../controllers/transfer_item.controller"

import {
    createBarcodeForTransferDocItem,
    updateBarcodeForTransferDocItem,
    deleteBarcodeForTransferDocItem,
} from "../controllers/barcode.transfer_item.controller"

import {
    scanTransferDocLocation,
    scanTransferDocNcrLocation,
    scanTransferDocBarcode,
    confirmTransferDocPick,
    confirmTransferDocPutToStock,
    scanTransferDocBarcodePut,
} from "../controllers/transfer.scan.controller"

const router = Router();

// transfer
router.post("/create", createTransferDoc);
router.get("/getAll", getTransferDocs);
router.get("/get", auth, attachDepartmentAccess, getTransferDocsPaginated);
router.get("/get/:no", getTransferDocByNo);
router.patch("/update/:no", updateTransferDoc);
router.delete("/delete/:no", deleteTransferDoc);

// transfer odoo
router.get("/odoo/getAll", getOdooTransferDocs);
router.get("/odoo/get/:no", getOdooTransferDocByNo);
router.get("/odoo/get/:no/paginated", getOdooTransferDocByNoPaginated);
router.patch("/odoo/update/:no", updateOdooTransferDoc);
router.delete("/odoo/delete/:no", deleteOdooTransferDoc);

// transfer_item
router.post("/item/create", createTransferDocItem);
router.get("/item/getAll", getTransferDocItems);
router.get("/item/get", getTransferDocItemsPaginated);
router.get("/item/get/:id", getTransferDocItemById);
router.patch("/item/update/:id", updateTransferDocItem);
router.delete("/item/delete/:id", deleteTransferDocItem);

//item barcode
router.post("/item/barcode/create", createBarcodeForTransferDocItem);
router.post("/item/barcode/update/:transfer_doc_item_id", updateBarcodeForTransferDocItem);
router.post("/item/barcode/delete/:transfer_doc_item_id", deleteBarcodeForTransferDocItem);

// scan
router.post("/:no/scan/location", scanTransferDocLocation);
router.post("/:no/scan/location/ncr", scanTransferDocNcrLocation);
router.post("/:no/scan/barcode", scanTransferDocBarcode);
router.post("/:no/scan/barcode/put", scanTransferDocBarcodePut);
router.post("/:no/scan/confirm", confirmTransferDocPick);
router.post("/:no/scan/confirm/put", confirmTransferDocPutToStock);

export default router;