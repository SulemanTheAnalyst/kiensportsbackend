import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const database = await prisma.$queryRaw<
    { current_database: string }[]
  >`SELECT current_database()`;

  if (database[0]?.current_database !== 'kien_sports_test') {
    throw new Error('Refusing to seed a database other than kien_sports_test.');
  }

  console.log('Test database confirmed.');

  // Roles
  for (const name of ['CUSTOMER', 'ADMIN'] as const) {
    await prisma.role.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  // Categories
  const categories = [
    ['bags', 'Bags', 'sport', 'Performance bags built for athletes.', 1],
    ['training', 'Training', 'sport', 'Training essentials for peak performance.', 2],
    ['running', 'Running', 'sport', 'Built for the road and the trail.', 3],
    ['apparel', 'Apparel', 'sport', 'Performance apparel for every sport.', 4],
    ['footwear', 'Footwear', 'sport', 'Engineered footwear for movement.', 5],
    ['accessories', 'Accessories', 'sport', 'Complete your training setup.', 6],
    ['sports-gear', 'Sports Gear', 'sport', 'Equipment built for performance.', 7],
    ['sling-bags', 'Sling Bags', 'lifestyle', 'Minimal carry for maximum freedom.', 8],
    ['everyday-bags', 'Everyday Bags', 'lifestyle', 'Everyday carry, elevated.', 9],
    ['lifestyle', 'Lifestyle', 'lifestyle', 'Purpose-built for the journey.', 10],
    ['everyday-carry', 'Everyday Carry', 'lifestyle', 'The essentials, organized.', 11],
    ['lifestyle-accessories', 'Lifestyle Accessories', 'lifestyle', 'Finishing touches.', 12],
  ] as const;

  for (const [slug, name, world, description, sortOrder] of categories) {
    await prisma.category.upsert({
      where: { slug },
      update: { name, world, description, sortOrder },
      create: { slug, name, world, description, sortOrder },
    });
  }

  // Collections
  const collections = [
    ['athlete-series', 'Athlete Series', 'Engineered for athletes who demand more.'],
    ['training-series', 'Training Series', 'Purpose-built for training.'],
    ['everyday-series', 'Everyday Series', 'Minimal carry for maximum freedom.'],
  ] as const;

  for (const [slug, name, description] of collections) {
    await prisma.collection.upsert({
      where: { slug },
      update: { name, description },
      create: { slug, name, description },
    });
  }

  console.log('Test fixtures created successfully.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
