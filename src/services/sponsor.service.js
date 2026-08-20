const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

function listActiveSponsors() {
  return prisma.sponsor.findMany({ where: { isActive: true }, orderBy: { createdAt: 'desc' } });
}

function listSponsors() {
  return prisma.sponsor.findMany({ orderBy: { createdAt: 'desc' } });
}

function createSponsor({ name, logoUrl, websiteUrl }) {
  return prisma.sponsor.create({ data: { name: String(name).trim().toUpperCase(), logoUrl, websiteUrl: websiteUrl || null } });
}

async function deleteSponsor(id) {
  const sponsor = await prisma.sponsor.findUnique({ where: { id: Number(id) } });
  if (!sponsor) throw new AppError('Sponsor not found', 404);
  return prisma.sponsor.delete({ where: { id: Number(id) } });
}

module.exports = { listActiveSponsors, listSponsors, createSponsor, deleteSponsor };
