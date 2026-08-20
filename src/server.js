const app = require('./app');
const prisma = require('./config/prisma');

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await prisma.$connect();
    app.listen(PORT, () => {
      console.log(`JPSME server running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to connect to the database. Is XAMPP MySQL running and DATABASE_URL correct?');
    console.error(err);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

start();
