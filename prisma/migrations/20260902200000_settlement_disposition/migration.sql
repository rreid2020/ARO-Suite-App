-- Settlement posting flags: retire the ARO asset, or extinguish because the related TCA was sold.
ALTER TABLE "settlement" ADD COLUMN "disposeAroAsset" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "settlement" ADD COLUMN "relatedAssetSold" BOOLEAN NOT NULL DEFAULT false;
