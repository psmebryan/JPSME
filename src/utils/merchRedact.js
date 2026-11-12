// What a store admin may see of the data, applied on the server before it
// reaches a page, a JSON response or an export (phase 4, the plan's field
// permissions). caps is the Set from adminAccess.merchCapsFor.
//
//   Costs      unit cost, stock value at cost, profit: only with cost.view
//              (the main admin, Finance, a President given "costs and profit").
//   Addresses  the delivery address and phone on an order: only with
//              addresses.view (the main admin, Logistics), and for Logistics
//              only while the order still has to travel: until it is
//              delivered or closed, or while a return or exchange on it is open.

const COST_KEY = /cost|^valueCentavos$|^profit|^margin/i;
const COST_FIELDS = ['costCentavos', 'unitCostCentavos'];

// A copy of value without any cost or profit figure in it, at any depth. Price
// history rows about the cost are dropped whole.
function withoutCosts(value) {
  if (Array.isArray(value)) {
    return value.filter((r) => !(r && typeof r === 'object' && COST_FIELDS.includes(r.field))).map(withoutCosts);
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    Object.keys(value).forEach((k) => {
      if (k === 'costMissing' || COST_KEY.test(k)) return;
      out[k] = withoutCosts(value[k]);
    });
    return out;
  }
  return value;
}

const costs = (caps, value) => (caps && caps.has('cost.view') ? value : withoutCosts(value));

// Statuses after which a delivery address is no longer needed for the work.
const DONE = ['DELIVERED', 'PICKED_UP', 'UNCLAIMED', 'CANCELLED', 'REFUNDED'];

function canSeeAddress(caps, user, order, { openReturn = false } = {}) {
  if (!caps || !caps.has('addresses.view')) return false;
  if (user && user.role === 'ADMIN') return true;
  return !DONE.includes(order.status) || Boolean(openReturn);
}

// An order (as presentOrder gives it) with the address taken out when this
// person may not see it. addressHidden tells the page why it is blank.
function order(caps, user, o, opts) {
  if (!o || !o.shipTo || canSeeAddress(caps, user, o, opts)) return o;
  return { ...o, shipTo: null, shipLines: null, addressHidden: true };
}

module.exports = { withoutCosts, costs, canSeeAddress, order, DONE };
