export interface DetectedImageType {
  contentType: string;
  extension: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ascii(buffer: Buffer, start: number, end: number): string {
  return buffer.toString('ascii', start, end);
}

/**
 * Déduit le type réel depuis les premiers octets du fichier.
 * On ne fait pas confiance au Content-Type envoyé par le client : un bucket
 * public renverrait sinon un fichier HTML avec un type image.
 */
export function detectImageType(buffer: Buffer): DetectedImageType | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { contentType: 'image/png', extension: 'png' };
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }

  if (buffer.length >= 6) {
    const gif = ascii(buffer, 0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') {
      return { contentType: 'image/gif', extension: 'gif' };
    }
  }

  if (
    buffer.length >= 12 &&
    ascii(buffer, 0, 4) === 'RIFF' &&
    ascii(buffer, 8, 12) === 'WEBP'
  ) {
    return { contentType: 'image/webp', extension: 'webp' };
  }

  if (buffer.length >= 12 && ascii(buffer, 4, 8) === 'ftyp') {
    const brand = ascii(buffer, 8, 12).toLowerCase();
    if (brand === 'avif' || brand === 'avis') {
      return { contentType: 'image/avif', extension: 'avif' };
    }
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx') {
      return { contentType: 'image/heic', extension: 'heic' };
    }
    if (brand === 'mif1' || brand === 'msf1') {
      return { contentType: 'image/heif', extension: 'heif' };
    }
  }

  return null;
}
