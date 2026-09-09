/**
 * Injects the Google Photo Sphere ("GPano") XMP metadata block into a JPEG
 * so viewers (Google Photos, most 360° viewers) recognize it as a
 * full 360°x180° equirectangular panorama automatically, without the user
 * having to pick "view as photosphere" manually.
 *
 * Implemented by hand (rather than via sharp, which doesn't expose
 * arbitrary XMP injection) because the format is simple: one APP1 marker
 * segment, right after the JPEG's SOI marker, containing the Adobe XMP
 * namespace identifier followed by an RDF/XML packet.
 */

const XMP_NAMESPACE = 'http://ns.adobe.com/xap/1.0/\0';

function buildXmpPacket(width: number, height: number): string {
  return (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" ' +
    'xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" ' +
    'GPano:UsePanoramaViewer="True" ' +
    'GPano:ProjectionType="equirectangular" ' +
    `GPano:FullPanoWidthPixels="${width}" ` +
    `GPano:FullPanoHeightPixels="${height}" ` +
    `GPano:CroppedAreaImageWidthPixels="${width}" ` +
    `GPano:CroppedAreaImageHeightPixels="${height}" ` +
    'GPano:CroppedAreaLeftPixels="0" ' +
    'GPano:CroppedAreaTopPixels="0" ' +
    'GPano:CaptureSoftware="panorama-app" />' +
    '</rdf:RDF>' +
    '</x:xmpmeta>' +
    '<?xpacket end="w"?>'
  );
}

export function injectGPanoXmp(jpeg: Buffer, width: number, height: number): Buffer {
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error('injectGPanoXmp: input is not a JPEG (missing SOI marker)');
  }

  const nsBuf = Buffer.from(XMP_NAMESPACE, 'ascii');
  const xmpBuf = Buffer.from(buildXmpPacket(width, height), 'utf-8');
  const segmentLength = nsBuf.length + xmpBuf.length + 2; // +2 for the length field itself, per the JPEG marker-segment format
  if (segmentLength > 0xffff) {
    throw new Error(`injectGPanoXmp: XMP packet too large for a single APP1 segment (${segmentLength} bytes)`);
  }

  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = 0xe1; // APP1
  header.writeUInt16BE(segmentLength, 2);

  const app1Segment = Buffer.concat([header, nsBuf, xmpBuf]);
  return Buffer.concat([jpeg.subarray(0, 2), app1Segment, jpeg.subarray(2)]);
}
