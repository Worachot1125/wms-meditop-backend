-- ลบ migration record ที่ failed ออก
DELETE FROM "_prisma_migrations" 
WHERE migration_name = '20260130043534_restructure_barcode_add_odoo_fields';
