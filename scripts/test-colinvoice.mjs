// Unit test for worker/colinvoice.js with made-up Busy-style invoices (both layouts). Run: node scripts/test-colinvoice.mjs
import { parseColumnInvoice, serialLike } from '../worker/colinvoice.js';
let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) pass++; else { fail++; console.log('✗', m, d ?? ''); } };
const row = (...cells) => ({ cells: cells.map(([x, s]) => ({ x, s })) });

const standard = [
  row([23, 'GSTIN'], [63, ':'], [74, '07AAAAA0000A1Z5'], [477, 'Original for RECIPIENT']),
  row([257, 'TAX INVOICE']),
  row([174, 'Demo Printer Services Pvt. Ltd.']),
  row([23, 'Invoice No.'], [108, ':'], [120, '26-27/0042'], [297, 'Transport'], [383, ':'], [394, 'Self']),
  row([23, 'Dated'], [108, ':'], [120, '05-11-2026'], [297, 'E-WAY BILL NO.'], [383, ':']),
  row([23, 'Place of Supply'], [108, ':'], [120, 'Rajasthan (08)'], [297, 'Packed By'], [383, ':'], [394, 'A']),
  row([23, 'Reverse Charge'], [108, ':'], [120, 'N'], [297, 'Po No & Date'], [383, ':'], [394, 'PO/77 DT. 01-11-2026']),
  row([23, 'Billed to'], [77, ':'], [297, 'Shipped to'], [357, ':']),
  row([23, 'Sunrise Dairy Ltd.'], [297, 'Sunrise Dairy Ltd. (Plant 2)']),
  row([23, 'Plot 9, RIICO Area'], [297, 'Plot 44, RIICO Area']),
  row([23, 'Distt Jaipur'], [297, 'Distt Jaipur']),
  row([23, '302013'], [297, '302013']),
  row([23, 'Party Mobile No'], [108, ':'], [120, '9800000001'], [297, 'Party Mobile No'], [383, ':']),
  row([23, 'GSTIN / UIN'], [108, ':'], [120, '08ABCDE1234F1Z5'], [297, 'GSTIN / UIN'], [383, ':'], [394, '08ABCDE1234F1Z5']),
  row([23, 'S.N. Description of Goods'], [208, 'HSN/SAC'], [271, 'Qty. Unit'], [351, 'List Price Discount'], [485, 'Price'], [524, 'Amount (` )']),
  row([208, 'Code']),
  row([31, '1. TSC TE 310 Hybrid'], [208, '84433290'], [273, '3.00 OTH'], [353, '22,300.00'], [534, '66,900.00']),
  row([51, 'DMOX26110001, DMOX26110002, DMOX26110003']),
  row([31, '2. Comprehensive TSC Service Pack'], [208, '998713'], [273, '3.00 Units'], [358, '11,500.00'], [534, '34,500.00']),
  row([51, 'from Day 1 to 5 Years']),
  row([51, 'Maximum 2 Print Head Covers']),
  row([51, 'RETURN TO BASE Demo Office']),
  row([31, '3. TSC TE 210'], [208, '84433290'], [273, '1.00 OTH'], [353, '13,750.00'], [534, '13,750.00']),
  row([51, 'WARRANTY ON PRINT HEAD 6 MONTHS']),
  row([51, 'OR 25KM WHICHEVER COMES FIRST. PRINTER 1 YEAR']),
  row([51, 'DMAT26110009']),
  row([31, '4. General Terms & Conditions'], [273, '1.00 ---'], [534, '0.00']),
  row([51, '100% Payment on Delivery']),
  row([529, '1,15,150.00']),
  row([284, 'Add'], [305, ': IGST'], [539, '20,727.00']),
];
let r = parseColumnInvoice(standard);
ok(r && r.format === 'busy-standard', 'standard layout recognised', r?.format);
ok(r.invoiceNumber === '26-27/0042' && r.invoiceDate === '2026-11-05', 'invoice number and date', [r.invoiceNumber, r.invoiceDate]);
ok(r.poRef === 'PO/77 DT. 01-11-2026', 'customer PO');
ok(r.customer.name === 'Sunrise Dairy Ltd.' && r.customer.postal === '302013' && r.customer.city === 'Jaipur' && r.customer.state === 'Rajasthan', 'billed-to customer (not shipped-to)', r.customer);
ok(r.customer.gstin === '08ABCDE1234F1Z5' && r.customer.mobile === '9800000001', 'customer GSTIN and mobile', r.customer);
ok(r.sets.length === 2, 'two printers, terms line ignored', r.sets.length);
ok(r.sets[0].model === 'TE310' && r.sets[0].brand === 'TSC Auto ID' && r.sets[0].serials.length === 3, 'printer 1 model, brand, serials', r.sets[0]);
ok(r.sets[0].carePack?.years === 5 && r.sets[0].carePack.headLimit === 2 && r.sets[0].carePack.service === 'Return to base' && r.sets[0].carePack.comprehensive, 'care pack 5 years, 2 heads, return to base', r.sets[0].carePack);
ok(!r.sets[1].carePack && r.sets[1].serials[0] === 'DMAT26110009' && r.sets[1].warranty.printerYears === 1 && r.sets[1].warranty.headMonths === 6 && r.sets[1].warranty.headKm === 25, 'printer 2: standard warranty only', r.sets[1]);
ok(r.warnings.some((w) => /no care pack/.test(w)), 'warns about printer without care pack');

const custom = [
  row([194, 'GSTIN'], [238, ': 07AAAAA0000A1Z5']),
  row([254, 'TAX INVOICE']),
  row([33, 'Party Details :'], [293, 'Invoice No.'], [385, ':'], [396, '26-27/0043']),
  row([33, 'Coastal Packaging Co'], [293, 'Dated'], [385, ':'], [396, '06-11-2026']),
  row([33, '12, Harbour Road,'], [293, 'P.O No./Date'], [385, ':']),
  row([33, 'Kochi'], [293, 'Place of Supply'], [385, ':'], [396, 'Kerala (32)'], [509, 'State 32']),
  row([33, '682001'], [293, 'E-WAY BILL NO.'], [385, ':']),
  row([189, 'Kerala (32)'], [293, 'Packed By'], [385, ':'], [396, 'A']),
  row([33, 'Party GSTIN'], [114, ':'], [125, '32ABCDE1234F1Z9'], [293, 'GR No.'], [385, ':']),
  row([33, 'Mobile No.'], [114, ':'], [125, '9800000002'], [293, 'Vehicle No.'], [385, ':'], [396, 'KL07AB1234']),
  row([34, 'S.N.'], [60, 'Description of Goods'], [281, 'HSN/SAC'], [358, 'Qty. Unit'], [445, 'Price'], [496, 'Amount(` )']),
  row([43, '1.'], [60, 'TSC TE 244 Hybrid'], [281, '84433290'], [357, '2.00 OTH'], [422, '12,033.90'], [502, '24,067.80']),
  row([60, '7DM226110021, 7DM226110022']),
  row([43, '2.'], [60, 'Comprehensive TSC Service Pack'], [281, '998713'], [357, '2.00 Units'], [422, '8,200.00'], [502, '16,400.00']),
  row([60, 'from Day 1 to 3 Years']),
  row([60, 'Maximum 2 Print Heads Changes in']),
  row([60, 'CHN/26-27/00042']),
  row([387, 'Sub Total :'], [509, '40,467.80']),
  row([33, 'Bank Name'], [114, ':'], [125, 'Demo Bank'], [337, 'Bank Name']),
  row([33, 'A/c No.'], [114, ':'], [125, '0000111122223333']),
];
r = parseColumnInvoice(custom);
ok(r && r.format === 'busy-custom', 'customised layout recognised', r?.format);
ok(r.invoiceNumber === '26-27/0043' && r.invoiceDate === '2026-11-06' && r.poRef === '', 'invoice fields', r);
ok(r.customer.name === 'Coastal Packaging Co' && r.customer.city === 'Kochi' && r.customer.postal === '682001' && r.customer.state === 'Kerala' && r.customer.gstin === '32ABCDE1234F1Z9', 'party details', r.customer);
ok(r.sets.length === 1 && r.sets[0].model === 'TE244' && r.sets[0].serials.join() === '7DM226110021,7DM226110022', 'printer and serials', r.sets[0]);
ok(r.sets[0].carePack?.years === 3 && r.sets[0].carePack.headLimit === 2 && r.sets[0].carePack.reference === 'CHN/26-27/00042', 'care pack with reference', r.sets[0].carePack);
ok(!r.sets[0].serials.some((s) => /KL07|0000111122223333/.test(s)), 'vehicle and bank numbers are not serials');

ok(parseColumnInvoice([row([10, 'Invoice No: 1'])]) === null, 'other PDFs fall back to plain-text reading');
ok(serialLike('TEAT26150915') && serialLike('7TE226282601') && !serialLike('03AACCS3003L1ZS') && !serialLike('300DPI') && !serialLike('26-27'), 'serial shape rules');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
