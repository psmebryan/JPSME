// Creates (or updates) the initial admin account. Run with `npm run db:seed`.
// Override credentials via env vars before running in a real environment.
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL || "admin@jpsme.local";
  const password = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
  const hashedPassword = await bcrypt.hash(password, 12);

  const admin = await prisma.user.upsert({
    where: { email },
    update: { role: "ADMIN", status: "APPROVED", emailVerifiedAt: new Date() },
    create: {
      firstName: "Site",
      middleInitial: "A",
      lastName: "Admin",
      email,
      password: hashedPassword,
      role: "ADMIN",
      status: "APPROVED",
      emailVerifiedAt: new Date(),
    },
  });

  console.log(`Admin ready: ${admin.email}`);
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.log(
      `Default password: ${password} (change this after first login)`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
