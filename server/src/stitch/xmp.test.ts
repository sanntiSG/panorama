import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { injectGPanoXmp } from './xmp.js';

async function makeTestJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .jpeg()
    .toBuffer();
}

describe('injectGPanoXmp', () => {
  it('produces a JPEG that still decodes correctly, with the same dimensions', async () => {
    const original = await makeTestJpeg(64, 32);
    const withXmp = injectGPanoXmp(original, 64, 32);

    expect(withXmp[0]).toBe(0xff);
    expect(withXmp[1]).toBe(0xd8);
    expect(withXmp.length).toBeGreaterThan(original.length);

    const meta = await sharp(withXmp).metadata();
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(32);
    expect(meta.format).toBe('jpeg');
  });

  it('embeds the Adobe XMP namespace and GPano fields as bytes', async () => {
    const original = await makeTestJpeg(8, 8);
    const withXmp = injectGPanoXmp(original, 8, 8);
    const text = withXmp.toString('latin1');
    expect(text).toContain('http://ns.adobe.com/xap/1.0/');
    expect(text).toContain('GPano:ProjectionType="equirectangular"');
    expect(text).toContain('GPano:FullPanoWidthPixels="8"');
  });

  it('rejects non-JPEG input', () => {
    expect(() => injectGPanoXmp(Buffer.from([0x00, 0x01, 0x02]), 10, 10)).toThrow();
  });
});
