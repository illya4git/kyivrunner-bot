import QRCode from 'qrcode';

/**
 * PNG of the ticket's raw QR payload (docs: the validator scans `code` as-is).
 * Large, high-contrast and with a generous quiet zone so phone screens scan reliably.
 */
export function renderQr(payload: string): Promise<Buffer> {
  return QRCode.toBuffer(payload, {
    type: 'png',
    errorCorrectionLevel: 'M',
    width: 640,
    margin: 4,
    color: { dark: '#000000', light: '#ffffff' },
  });
}
