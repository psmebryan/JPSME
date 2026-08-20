const { Router } = require('express');
const registrationApi = require('../../controllers/api/registration.api');
const { apiAuth } = require('../../middleware/auth.middleware');

const router = Router();

router.get('/me', apiAuth, registrationApi.myRegistrations);

module.exports = router;
