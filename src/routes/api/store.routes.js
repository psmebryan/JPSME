const { Router } = require('express');
const { param, body, validationResult } = require('express-validator');
const storeApi = require('../../controllers/api/store.api');
const { apiAuth } = require('../../middleware/auth.middleware');
const { verifyCsrfToken } = require('../../middleware/csrf.middleware');
const { uploadMerchPhotos } = require('../../middleware/upload.middleware');
const { verifyImageSignatures } = require('../../middleware/verifyImageSignature');

// The merchandise store for buyers. Signed in only; every change carries the
// CSRF token. Whether the store is open, prices, stock and limits are all
// decided by merchStore.service.
const router = Router();

function checkInput(req, res, next) {
  const result = validationResult(req);
  if (!result.isEmpty()) return res.status(400).json({ success: false, message: 'Invalid request data.', errors: result.array() });
  return next();
}

const variantParam = [param('variantId').isInt({ min: 1 }), checkInput];
const orderParam = [param('orderNumber').matches(/^ORD-\d{4}-\d{6,}$/), checkInput];

router.use(apiAuth);
router.get('/cart', storeApi.getCart);
router.post('/cart', verifyCsrfToken, body('variantId').isInt({ min: 1 }), body('quantity').optional().isInt({ min: 1, max: 100 }), checkInput, storeApi.addToCart);
router.put('/cart/:variantId', verifyCsrfToken, variantParam, body('quantity').isInt({ min: 0, max: 100 }), checkInput, storeApi.setQuantity);
router.delete('/cart/:variantId', verifyCsrfToken, variantParam, storeApi.removeFromCart);
router.post('/checkout', verifyCsrfToken, storeApi.checkout);
router.get('/orders/:orderNumber', orderParam, storeApi.myOrder);
router.post('/orders/:orderNumber/pay', verifyCsrfToken, orderParam, storeApi.payOrder);
router.post('/orders/:orderNumber/cancel', verifyCsrfToken, orderParam, storeApi.cancelOrder);
router.post('/orders/:orderNumber/address', verifyCsrfToken, orderParam, storeApi.fixAddress);

// Delivery and pickup.
router.get('/checkout-options', storeApi.checkoutOptions);
router.get('/delivery-quote', storeApi.deliveryQuote);
router.get('/psgc/regions', storeApi.psgcRegions);
router.get('/psgc/provinces', storeApi.psgcProvinces);
router.get('/psgc/cities', storeApi.psgcCities);
router.get('/psgc/barangays', storeApi.psgcBarangays);
const addressParam = [param('id').isInt({ min: 1 }), checkInput];
router.get('/addresses', storeApi.listAddresses);
router.post('/addresses', verifyCsrfToken, storeApi.addAddress);
router.put('/addresses/:id', verifyCsrfToken, addressParam, storeApi.updateAddress);
router.delete('/addresses/:id', verifyCsrfToken, addressParam, storeApi.deleteAddress);

// Refunds and exchanges.
const returnParam = [param('returnNumber').matches(/^RET-\d{4}-\d{6,}$/), checkInput];
router.get('/orders/:orderNumber/returns/form', orderParam, storeApi.returnForm);
router.post('/orders/:orderNumber/returns', verifyCsrfToken, orderParam, uploadMerchPhotos.fields([{ name: 'photo', maxCount: 1 }]), verifyImageSignatures, storeApi.requestReturn);
router.post('/returns/:returnNumber/withdraw', verifyCsrfToken, returnParam, storeApi.withdrawReturn);

module.exports = router;
