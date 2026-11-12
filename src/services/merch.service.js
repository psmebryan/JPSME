const ExcelJS = require('exceljs');
const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

// Merchandise store, phase 1 (admin -> Merchandise; JPSME Merchandise Store
// Plan v2): products, their photos and variants, and the stock ledger.
//
//   Product   Polo shirt, Cap, Pin, Lanyard. Off until the store opens.
//   Variant   what is stocked and sold ("Navy / L"): SKU, member price,
//             non-member price, unit cost, limit per buyer, low-stock level.
//             A price or cost left empty is not decided yet (TBD).
//   Ledger    stock is never typed over. Every change is one signed movement
//             with who, when and why, and on hand = the sum. Staff record
//             RECEIVED, DAMAGED and COUNT_CORRECTION here; checkout (a later
//             phase) will write HELD, RELEASED, SOLD and RETURNED.
//   History   every change to a variant's prices or cost is kept.
//
// Nothing here is shown to members yet: there is no public store page.

const MAX_PHOTOS = 6;
const MAX_CENTAVOS = 100000000; // PHP 1,000,000
const MAX_QTY = 100000;

// Movement types, and whether each counts toward stock on hand. Holds and
// releases only change what is free to sell, not what is on the shelf.
const MOVEMENTS = {
  RECEIVED: { label: 'Received', onHand: true, manual: true },
  DAMAGED: { label: 'Damaged or lost', onHand: true, manual: true },
  COUNT_CORRECTION: { label: 'Count correction', onHand: true, manual: true },
  SOLD: { label: 'Sold', onHand: true, manual: false },
  RETURNED: { label: 'Returned', onHand: true, manual: false },
  HELD: { label: 'Held for checkout', onHand: false, manual: false },
  RELEASED: { label: 'Released', onHand: false, manual: false },
};
const ON_HAND_TYPES = Object.keys(MOVEMENTS).filter((t) => MOVEMENTS[t].onHand);
const PRICE_FIELDS = { memberPriceCentavos: 'Member price', priceCentavos: 'Non-member price', costCentavos: 'Unit cost' };

// --- input -------------------------------------------------------------------------

function text(value, { label, max, required = false }) {
  const v = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!v) {
    if (required) throw new AppError(`Enter the ${label}`, 422);
    return null;
  }
  if (v.length > max) throw new AppError(`Keep the ${label} under ${max} characters`, 422);
  return v;
}

// Pesos from the form -> centavos. Empty = not decided (null). Accepts how
// people write prices: "350", "₱350", "PHP 1,500.50".
function money(value, label) {
  const raw = String(value == null ? '' : value).trim().replace(/^(₱|php)\s*/i, '').replace(/[,\s]/g, '');
  if (raw === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new AppError(`Enter the ${label} as a number, e.g. 350 or 1,500.50`, 422);
  const pesos = Number(raw);
  if (!Number.isFinite(pesos) || pesos < 0 || pesos * 100 > MAX_CENTAVOS) {
    throw new AppError(`The ${label} must be between 0 and 1,000,000`, 422);
  }
  return Math.round(pesos * 100);
}

function count(value, label, { min = 0, max = MAX_QTY, required = false } = {}) {
  const raw = String(value == null ? '' : value).trim();
  if (raw === '') {
    if (required) throw new AppError(`Enter the ${label}`, 422);
    return null;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new AppError(`The ${label} must be a whole number from ${min} to ${max.toLocaleString('en-US')}`, 422);
  }
  return Number(raw);
}

const asBool = (v) => v === true || v === 'true' || v === 'on' || v === '1' || v === 1;
const duplicate = (err) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// SKU: letters, digits and dashes, upper case. Empty -> built from the product
// and the variant's label ("POLO-NAVY-L").
function cleanSku(value, productName, label) {
  const given = String(value == null ? '' : value).trim().toUpperCase();
  if (given) {
    if (!/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(given)) throw new AppError('The SKU may use letters, digits and dashes only (up to 40)', 422);
    return given;
  }
  const part = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return [part(productName).split('-')[0], part(label)].filter(Boolean).join('-').slice(0, 40) || `SKU-${Date.now()}`;
}

// --- stock -------------------------------------------------------------------------

// On hand per variant, from the ledger. One grouped query for any number.
async function onHandFor(variantIds, db = prisma) {
  const ids = [...new Set(variantIds.map(Number))].filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await db.merchStockMovement.groupBy({
    by: ['variantId'],
    where: { variantId: { in: ids }, type: { in: ON_HAND_TYPES } },
    _sum: { quantity: true },
  });
  const map = new Map(ids.map((id) => [id, 0]));
  rows.forEach((r) => map.set(r.variantId, r._sum.quantity || 0));
  return map;
}

function stockState(onHand, lowStockLevel) {
  if (onHand <= 0) return 'SOLD_OUT';
  if (lowStockLevel !== null && lowStockLevel !== undefined && onHand <= lowStockLevel) return 'LOW';
  return 'OK';
}

function presentVariant(v, onHand) {
  return {
    id: v.id,
    productId: v.productId,
    sku: v.sku,
    label: v.label,
    size: v.size,
    color: v.color,
    memberPriceCentavos: v.memberPriceCentavos,
    priceCentavos: v.priceCentavos,
    costCentavos: v.costCentavos,
    limitPerBuyer: v.limitPerBuyer,
    lowStockLevel: v.lowStockLevel,
    isActive: v.isActive,
    sortOrder: v.sortOrder,
    onHand,
    stockState: stockState(onHand, v.lowStockLevel),
  };
}

// --- products ----------------------------------------------------------------------

const PRODUCT_INCLUDE = {
  images: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
  variants: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
};

async function presentProducts(products) {
  const stock = await onHandFor(products.flatMap((p) => p.variants.map((v) => v.id)));
  return products.map((p) => {
    const variants = p.variants.map((v) => presentVariant(v, stock.get(v.id) || 0));
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      isActive: p.isActive,
      sortOrder: p.sortOrder,
      images: p.images.map((i) => ({ id: i.id, url: i.url })),
      variants,
      onHand: variants.reduce((t, v) => t + v.onHand, 0),
      lowCount: variants.filter((v) => v.isActive && v.stockState !== 'OK').length,
      pricesMissing: variants.filter((v) => v.memberPriceCentavos === null || v.priceCentavos === null).length,
    };
  });
}

async function listProducts() {
  const products = await prisma.merchProduct.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], include: PRODUCT_INCLUDE });
  return presentProducts(products);
}

async function getProduct(id) {
  const product = await prisma.merchProduct.findUnique({ where: { id: Number(id) || 0 }, include: PRODUCT_INCLUDE });
  if (!product) throw new AppError('Product not found', 404);
  return (await presentProducts([product]))[0];
}

async function createProduct({ name, description, isActive }) {
  const count0 = await prisma.merchProduct.count();
  try {
    const p = await prisma.merchProduct.create({
      data: {
        name: text(name, { label: 'product name', max: 80, required: true }),
        description: text(description, { label: 'description', max: 4000 }),
        isActive: asBool(isActive),
        sortOrder: count0,
      },
    });
    return getProduct(p.id);
  } catch (err) {
    if (duplicate(err)) throw new AppError('There is already a product with that name', 409);
    throw err;
  }
}

async function updateProduct(id, { name, description, isActive, sortOrder }) {
  const product = await getProduct(id);
  const data = {};
  if (name !== undefined) data.name = text(name, { label: 'product name', max: 80, required: true });
  if (description !== undefined) data.description = text(description, { label: 'description', max: 4000 });
  if (isActive !== undefined) data.isActive = asBool(isActive);
  if (sortOrder !== undefined && Number.isInteger(Number(sortOrder))) data.sortOrder = Number(sortOrder);
  try {
    await prisma.merchProduct.update({ where: { id: product.id }, data });
  } catch (err) {
    if (duplicate(err)) throw new AppError('There is already a product with that name', 409);
    throw err;
  }
  return getProduct(product.id);
}

// Only a product with no stock history can be removed; otherwise it is
// switched off, so the ledger never loses a line. Returns the photo files to
// delete.
async function deleteProduct(id) {
  const product = await getProduct(id);
  const moved = await prisma.merchStockMovement.count({ where: { variant: { productId: product.id } } });
  if (moved) throw new AppError('This product has stock history, so it cannot be removed. Switch it off instead.', 409);
  await prisma.merchProduct.delete({ where: { id: product.id } });
  return { id: product.id, files: product.images.map((i) => i.url) };
}

async function addPhotos(productId, urls) {
  const product = await getProduct(productId);
  if (product.images.length + urls.length > MAX_PHOTOS) {
    throw new AppError(`Up to ${MAX_PHOTOS} photos per product (this one has ${product.images.length})`, 422);
  }
  await prisma.$transaction(urls.map((url, i) => prisma.merchProductImage.create({
    data: { productId: product.id, url, sortOrder: product.images.length + i },
  })));
  return getProduct(product.id);
}

async function removePhoto(productId, imageId) {
  const image = await prisma.merchProductImage.findUnique({ where: { id: Number(imageId) || 0 } });
  if (!image || image.productId !== Number(productId)) throw new AppError('Photo not found', 404);
  await prisma.merchProductImage.delete({ where: { id: image.id } });
  return { product: await getProduct(productId), file: image.url };
}

// --- variants ----------------------------------------------------------------------

async function findVariant(productId, variantId) {
  const v = await prisma.merchVariant.findUnique({ where: { id: Number(variantId) || 0 }, include: { product: { select: { name: true } } } });
  if (!v || (productId !== null && v.productId !== Number(productId))) throw new AppError('Variant not found', 404);
  return v;
}

function variantFields(body, { creating }) {
  const data = {};
  const has = (k) => body[k] !== undefined;
  if (creating || has('label')) data.label = text(body.label, { label: 'variant name', max: 80, required: true });
  if (has('size')) data.size = text(body.size, { label: 'size', max: 20 });
  if (has('color')) data.color = text(body.color, { label: 'colour', max: 30 });
  if (has('memberPrice')) data.memberPriceCentavos = money(body.memberPrice, 'member price');
  if (has('price')) data.priceCentavos = money(body.price, 'non-member price');
  if (has('cost')) data.costCentavos = money(body.cost, 'unit cost');
  if (has('limitPerBuyer')) data.limitPerBuyer = count(body.limitPerBuyer, 'limit per buyer', { min: 1, max: 1000 });
  if (has('lowStockLevel')) data.lowStockLevel = count(body.lowStockLevel, 'low-stock level', { min: 0, max: MAX_QTY });
  if (has('isActive')) data.isActive = asBool(body.isActive);
  return data;
}

async function addVariant(productId, body, actorId = null) {
  const product = await getProduct(productId);
  const data = variantFields(body, { creating: true });
  data.sku = cleanSku(body.sku, product.name, data.label);
  try {
    const v = await prisma.$transaction(async (tx) => {
      const created = await tx.merchVariant.create({ data: { ...data, productId: product.id, sortOrder: product.variants.length } });
      // The first prices count as history too: who set them and when.
      const lines = Object.keys(PRICE_FIELDS).filter((f) => created[f] !== null)
        .map((f) => ({ variantId: created.id, field: f, oldValue: null, newValue: created[f], actorId }));
      if (lines.length) await tx.merchPriceChange.createMany({ data: lines });
      return created;
    });
    return presentVariant(v, 0);
  } catch (err) {
    if (duplicate(err)) throw new AppError('That SKU or variant name is already used', 409);
    throw err;
  }
}

async function updateVariant(productId, variantId, body, actorId = null) {
  const existing = await findVariant(productId, variantId);
  const data = variantFields(body, { creating: false });
  if (body.sku !== undefined) data.sku = cleanSku(body.sku, existing.product.name, data.label || existing.label);
  try {
    const v = await prisma.$transaction(async (tx) => {
      const updated = await tx.merchVariant.update({ where: { id: existing.id }, data });
      const lines = Object.keys(PRICE_FIELDS).filter((f) => f in data && data[f] !== existing[f])
        .map((f) => ({ variantId: existing.id, field: f, oldValue: existing[f], newValue: data[f], actorId }));
      if (lines.length) await tx.merchPriceChange.createMany({ data: lines });
      return updated;
    });
    return presentVariant(v, (await onHandFor([v.id])).get(v.id) || 0);
  } catch (err) {
    if (duplicate(err)) throw new AppError('That SKU or variant name is already used', 409);
    throw err;
  }
}

async function deleteVariant(productId, variantId) {
  const v = await findVariant(productId, variantId);
  const moved = await prisma.merchStockMovement.count({ where: { variantId: v.id } });
  if (moved) throw new AppError('This variant has stock history, so it cannot be removed. Switch it off instead.', 409);
  await prisma.merchVariant.delete({ where: { id: v.id } });
  return { id: v.id };
}

async function priceHistory(variantId) {
  const v = await findVariant(null, variantId);
  const rows = await prisma.merchPriceChange.findMany({
    where: { variantId: v.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: { actor: { select: { firstName: true, lastName: true } } },
  });
  return rows.map((r) => ({
    id: r.id, field: r.field, fieldLabel: PRICE_FIELDS[r.field] || r.field, oldValue: r.oldValue, newValue: r.newValue,
    by: r.actor ? `${r.actor.firstName} ${r.actor.lastName}` : null, at: r.createdAt,
  }));
}

// --- the ledger: what staff record --------------------------------------------------

// RECEIVED: stock in from a supplier. DAMAGED: out, with a reason, never more
// than is on hand. COUNT: a physical count; the difference from the ledger is
// recorded as a COUNT_CORRECTION (0 when it matches, which still proves the
// count was done). Serializable, so two people recording at once cannot both
// read the same on-hand figure.
async function recordStock(variantId, { action, quantity, counted, reason, supplier, unitCost }, actorId) {
  const v = await findVariant(null, variantId);
  const why = text(reason, { label: 'reason', max: 300, required: action !== 'receive' });
  let attempt = 0;
  for (;;) {
    try {
      return await prisma.$transaction(async (tx) => {
        const onHand = (await onHandFor([v.id], tx)).get(v.id) || 0;
        let data;
        if (action === 'receive') {
          data = {
            type: 'RECEIVED',
            quantity: count(quantity, 'quantity received', { min: 1, required: true }),
            supplier: text(supplier, { label: 'supplier', max: 120 }),
            unitCostCentavos: money(unitCost, 'unit cost'),
            reason: why,
          };
        } else if (action === 'writeoff') {
          const q = count(quantity, 'quantity', { min: 1, required: true });
          if (q > onHand) throw new AppError(`Only ${onHand} on hand, so ${q} cannot be written off`, 422);
          data = { type: 'DAMAGED', quantity: -q, reason: why };
        } else if (action === 'count') {
          const c = count(counted, 'counted number', { min: 0, required: true });
          data = { type: 'COUNT_CORRECTION', quantity: c - onHand, reason: why };
        } else {
          throw new AppError('Choose receive, write off or count', 422);
        }
        const movement = await tx.merchStockMovement.create({ data: { ...data, variantId: v.id, actorId: actorId || null } });
        return { movement, onHand: onHand + movement.quantity };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (err) {
      attempt += 1;
      if (err.code === 'P2034' && attempt < 3) continue;
      if (err.code === 'P2034') throw new AppError('Someone else just changed this stock. Please try again.', 409);
      throw err;
    }
  }
}

// --- inventory and history ------------------------------------------------------------

const idOrNull = (v) => (/^[1-9]\d*$/.test(String(v || '')) ? Number(v) : null);

function parseInventoryFilters(query = {}) {
  const state = ['LOW', 'SOLD_OUT', 'OK'].includes(String(query.state || '').toUpperCase()) ? String(query.state).toUpperCase() : null;
  return {
    q: String(query.q || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    product: idOrNull(query.product),
    state,
    showOff: query.showOff === '1',
  };
}

async function listInventory(query) {
  const f = parseInventoryFilters(query);
  const variants = await prisma.merchVariant.findMany({
    where: {
      ...(f.product ? { productId: f.product } : {}),
      // Products start switched off until the store opens, so only switched-off
      // variants are hidden here, never a product that is simply not on sale yet.
      ...(f.showOff ? {} : { isActive: true }),
    },
    orderBy: [{ product: { sortOrder: 'asc' } }, { productId: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    include: { product: { select: { id: true, name: true, isActive: true } } },
  });
  const stock = await onHandFor(variants.map((v) => v.id));
  const last = variants.length ? await prisma.merchStockMovement.groupBy({
    by: ['variantId'], where: { variantId: { in: variants.map((v) => v.id) } }, _max: { createdAt: true },
  }) : [];
  const lastAt = new Map(last.map((r) => [r.variantId, r._max.createdAt]));
  const words = f.q.toLowerCase().split(' ').filter(Boolean);
  const rows = variants.map((v) => ({
    ...presentVariant(v, stock.get(v.id) || 0),
    productName: v.product.name,
    productActive: v.product.isActive,
    lastMovementAt: lastAt.get(v.id) || null,
  })).filter((r) => (!f.state || r.stockState === f.state)
    && words.every((w) => `${r.productName} ${r.label} ${r.sku}`.toLowerCase().includes(w)));
  return {
    filters: f,
    rows,
    totals: {
      variants: rows.length,
      units: rows.reduce((t, r) => t + r.onHand, 0),
      low: rows.filter((r) => r.stockState === 'LOW').length,
      soldOut: rows.filter((r) => r.stockState === 'SOLD_OUT').length,
      // Stock value at cost: only variants whose cost is known.
      valueCentavos: rows.reduce((t, r) => t + (r.costCentavos !== null ? r.costCentavos * Math.max(r.onHand, 0) : 0), 0),
      costMissing: rows.filter((r) => r.costCentavos === null && r.onHand > 0).length,
    },
  };
}

async function listMovements(variantId, { limit = 200 } = {}) {
  const v = await findVariant(null, variantId);
  const rows = await prisma.merchStockMovement.findMany({
    where: { variantId: v.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Number(limit) || 200, 1000),
    include: { actor: { select: { firstName: true, lastName: true } } },
  });
  return {
    variant: { id: v.id, sku: v.sku, label: v.label, productName: v.product.name },
    onHand: (await onHandFor([v.id])).get(v.id) || 0,
    movements: rows.map((m) => ({
      id: m.id, type: m.type, typeLabel: (MOVEMENTS[m.type] || {}).label || m.type, quantity: m.quantity,
      reason: m.reason, supplier: m.supplier, unitCostCentavos: m.unitCostCentavos,
      by: m.actor ? `${m.actor.firstName} ${m.actor.lastName}` : 'System', at: m.createdAt,
    })),
  };
}

// The inventory as a workbook: on hand (with the page's filters) and every
// movement of those variants. withCost false: the cost columns are left out.
async function exportInventoryExcel(query, { withCost = true } = {}) {
  const { rows } = await listInventory(query);
  const ids = rows.map((r) => r.id);
  const moves = ids.length ? await prisma.merchStockMovement.findMany({
    where: { variantId: { in: ids } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: { actor: { select: { firstName: true, lastName: true } }, variant: { select: { sku: true, label: true, product: { select: { name: true } } } } },
  }) : [];
  const peso = (c) => (c === null || c === undefined ? null : c / 100);
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet('On hand');
  const noCost = (cols) => (withCost ? cols : cols.filter((c) => !/cost/i.test(c.header)));
  a.columns = noCost([
    { header: 'Product', key: 'productName', width: 22 },
    { header: 'Variant', key: 'label', width: 20 },
    { header: 'SKU', key: 'sku', width: 20 },
    { header: 'On hand', key: 'onHand', width: 10 },
    { header: 'Low-stock level', key: 'lowStockLevel', width: 14 },
    { header: 'State', key: 'state', width: 12 },
    { header: 'Member price', key: 'memberPrice', width: 14, style: { numFmt: '"₱"#,##0.00' } },
    { header: 'Non-member price', key: 'price', width: 16, style: { numFmt: '"₱"#,##0.00' } },
    { header: 'Unit cost', key: 'cost', width: 12, style: { numFmt: '"₱"#,##0.00' } },
    { header: 'Value at cost', key: 'value', width: 14, style: { numFmt: '"₱"#,##0.00' } },
  ]);
  rows.forEach((r) => a.addRow({
    ...r,
    state: { OK: 'In stock', LOW: 'Low', SOLD_OUT: 'Sold out' }[r.stockState],
    memberPrice: peso(r.memberPriceCentavos), price: peso(r.priceCentavos), cost: peso(r.costCentavos),
    value: r.costCentavos === null ? null : (r.costCentavos * Math.max(r.onHand, 0)) / 100,
  }));
  const b = wb.addWorksheet('Movements');
  b.columns = noCost([
    { header: 'Date', key: 'at', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
    { header: 'Product', key: 'product', width: 22 },
    { header: 'Variant', key: 'variant', width: 20 },
    { header: 'SKU', key: 'sku', width: 20 },
    { header: 'Movement', key: 'type', width: 18 },
    { header: 'Quantity', key: 'quantity', width: 10 },
    { header: 'Reason', key: 'reason', width: 36 },
    { header: 'Supplier', key: 'supplier', width: 20 },
    { header: 'Unit cost', key: 'unitCost', width: 12, style: { numFmt: '"₱"#,##0.00' } },
    { header: 'By', key: 'by', width: 22 },
  ]);
  moves.forEach((m) => b.addRow({
    at: m.createdAt, product: m.variant.product.name, variant: m.variant.label, sku: m.variant.sku,
    type: (MOVEMENTS[m.type] || {}).label || m.type, quantity: m.quantity, reason: m.reason || '', supplier: m.supplier || '',
    unitCost: peso(m.unitCostCentavos), by: m.actor ? `${m.actor.firstName} ${m.actor.lastName}` : 'System',
  }));
  [a, b].forEach((s) => {
    s.getRow(1).font = { bold: true };
    s.views = [{ state: 'frozen', ySplit: 1 }];
    if (s.rowCount > 1) s.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: s.columnCount } };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = {
  MAX_PHOTOS,
  MOVEMENTS,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  addPhotos,
  removePhoto,
  addVariant,
  updateVariant,
  deleteVariant,
  priceHistory,
  recordStock,
  onHandFor,
  listInventory,
  listMovements,
  exportInventoryExcel,
};
