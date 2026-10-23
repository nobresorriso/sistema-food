// src/pix.mjs — gera o "copia e cola" do PIX (padrão EMV® QRCPS-MPM / BR Code)
// Observação: o código é gerado no padrão do Banco Central. A baixa do pagamento
// é manual no painel; para conciliação automática seria preciso um PSP (banco/gateway).

function emv(id, value) {
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function ascii(text, max) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .toUpperCase();
}

/**
 * Monta o payload PIX copia-e-cola.
 * Estrutura: 00 PFI | 26 conta do recebedor | 52 MCC | 53 moeda | 54 valor
 *            58 país | 59 nome | 60 cidade | 62 txid | 63 CRC16
 */
export function buildPixPayload({ key, holder, city = 'PORTO VELHO', amountCents = 0, txid = '***' }) {
  const name = ascii(holder, 25) || 'RESTAURANTE';
  const cityName = ascii(city, 15) || 'PORTO VELHO';
  const cleanKey = String(key || '').trim().slice(0, 77);
  const tx = (ascii(txid, 25).replace(/ /g, '') || '***').slice(0, 25);
  const amount = amountCents > 0 ? (amountCents / 100).toFixed(2) : '';

  const account = emv('00', 'BR.GOV.BCB.PIX') + emv('01', cleanKey);

  let payload = '';
  payload += emv('00', '01');            // Payload Format Indicator
  payload += emv('26', account);         // Merchant Account Information
  payload += emv('52', '0000');          // Merchant Category Code
  payload += emv('53', '986');           // Moeda: BRL
  if (amount) payload += emv('54', amount);
  payload += emv('58', 'BR');
  payload += emv('59', name);
  payload += emv('60', cityName);
  payload += emv('62', emv('05', tx));   // Additional data (txid)
  payload += '6304';
  return payload + crc16(payload);
}
