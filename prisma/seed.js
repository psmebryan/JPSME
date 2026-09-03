// Creates (or updates) the initial admin account. Run with `npm run db:seed`.
// Override credentials via env vars before running in a real environment.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL || "admin@jpsme.local";
  // Generated, not a fixed default. A hardcoded fallback becomes a published
  // credential the moment the repository is readable — anyone could look up
  // the admin password of any deployment that seeded without setting
  // SEED_ADMIN_PASSWORD and never changed it. Printed once below, and only
  // when it was generated rather than supplied.
  const providedPassword = process.env.SEED_ADMIN_PASSWORD;
  const password = providedPassword || crypto.randomBytes(12).toString("base64url");
  const hashedPassword = await bcrypt.hash(password, 12);

  // Whether the account already existed decides what may be said about the
  // password. An upsert cannot report that, and its update branch deliberately
  // does not touch the password — so on a re-run the generated one above was
  // never applied, and printing it would hand out a password that does not work.
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });

  const admin = existing
    ? await prisma.user.update({
      where: { email },
      data: {
        role: "ADMIN",
        status: "APPROVED",
        emailVerifiedAt: new Date(),
        // Only ever reset an existing account's password on an explicit
        // request, never on a routine re-seed.
        ...(providedPassword ? { password: hashedPassword } : {}),
      },
    })
    : await prisma.user.create({
      data: {
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
  if (existing) {
    console.log(providedPassword
      ? "Existing account — password reset to the supplied SEED_ADMIN_PASSWORD."
      : "Existing account — password left unchanged. Set SEED_ADMIN_PASSWORD to reset it.");
  } else if (!providedPassword) {
    console.log(`Generated password: ${password}`);
    console.log("Shown once — it is not recoverable from the database.");
    console.log("Save it now, or set SEED_ADMIN_PASSWORD and re-run to choose your own.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
