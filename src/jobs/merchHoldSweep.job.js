const merchStore = require('../services/merchStore.service');
const merchOrders = require('../services/merchOrders.service');

// Every minute: merchandise orders whose 30-minute stock hold has run out.
// Each one's PayMongo link is expired first, then the order is cancelled and
// its stock goes back on sale (merchStore.service closeOrder). A link PayMongo
// reports as already paid is confirmed instead.
//
// Also: orders ready for pickup for 7 days get one reminder email.
//
// Not gated by the payments switch: like the payment reconciliation sweep, it
// only settles orders already in flight.

const SWEEP_INTERVAL_MS = 60 * 1000;

async function runSweep() {
  try {
    const outcome = await merchStore.sweepExpiredHolds();
    if (outcome.cancelled || outcome.paidInstead || outcome.waiting) {
      console.log('Merchandise hold sweep:', JSON.stringify(outcome));
    }
  } catch (err) {
    console.error('Merchandise hold sweep failed:', err.message);
  }
  try {
    const reminded = await merchOrders.remindUncollected();
    if (reminded) console.log('Merchandise pickup reminders sent:', reminded);
  } catch (err) {
    console.error('Merchandise pickup reminders failed:', err.message);
  }
}

let intervalHandle = null;

function startMerchHoldSweep() {
  if (intervalHandle) return; // already running: don't double-schedule on a hot reload
  setTimeout(runSweep, 20 * 1000);
  intervalHandle = setInterval(runSweep, SWEEP_INTERVAL_MS);
  console.log('Merchandise hold sweep scheduled: every 1m');
}

function stopMerchHoldSweep() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { startMerchHoldSweep, stopMerchHoldSweep, runSweep };
