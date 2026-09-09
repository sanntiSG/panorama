import sharp from 'sharp';

export interface DecodedAlignImage {
  width: number;
  height: number;
  gray: Float32Array;
  /** downscaled width / original width — lets alignment-space pixel measurements convert back to full-res focal length units. */
  scale: number;
}

const ALIGN_MAX_DIM = 900;

/** Downscaled grayscale decode for feature-free alignment (align.ts). */
export async function decodeForAlignment(filePath: string, maxDim = ALIGN_MAX_DIM): Promise<DecodedAlignImage> {
  const image = sharp(filePath).rotate(); // no-op unless an EXIF orientation tag is present
  const meta = await image.metadata();
  const origWidth = meta.width ?? 0;
  const origHeight = meta.height ?? 0;
  if (!origWidth || !origHeight) throw new Error(`could not read image dimensions: ${filePath}`);

  const scale = Math.min(1, maxDim / Math.max(origWidth, origHeight));
  const width = Math.max(1, Math.round(origWidth * scale));
  const height = Math.max(1, Math.round(origHeight * scale));

  const { data } = await image
    .resize(width, height, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = data[i];

  return { width, height, gray, scale: width / origWidth };
}

export interface DecodedFullImage {
  width: number;
  height: number;
  channels: number;
  /** Interleaved, row-major, `channels`-per-pixel (3 for RGB, 4 if the source JPEG carries an alpha/CMYK-derived channel). */
  data: Uint8Array;
}

/** Full-resolution RGB decode, used one image at a time during rendering to avoid holding ~30 full-res buffers in memory at once. */
export async function decodeFullRes(filePath: string): Promise<DecodedFullImage> {
  const { data, info } = await sharp(filePath).rotate().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, channels: info.channels, data };
}
