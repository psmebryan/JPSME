const { PrismaClient } = require('@prisma/client');

// Single shared Prisma instance for the whole app (avoids exhausting DB connections).
const prisma = new PrismaClient();

module.exports = prisma;
