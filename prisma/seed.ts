import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { rupeesToPaise } from '../src/lib/money';

const prisma = new PrismaClient();

// Seed only the REAL current KIEN catalog: 3 products, 12 categories,
// the existing collections, and one admin user. No fake products.
const seed = async () => {
  // Roles
  for (const name of ['CUSTOMER', 'ADMIN'] as const) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  }

  // Categories (mirrors src/data/products.ts in the frontend)
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
    ['travel', 'Travel', 'lifestyle', 'Purpose-built for the journey.', 10],
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

  const img = (id: string) => 'https://images.unsplash.com/' + id;

  const products = [
    {
      slug: 'kien-athlete-40l',
      name: 'KIEN Athlete 40L Backpack',
      shortDescription: 'Engineered for athletes who demand more from their gear.',
      description:
        'The Athlete 40L is built around the way you actually move. From early morning training to late night travel, every compartment has a purpose. Engineered with water-resistant fabric, reinforced stitching, and ergonomic shoulder straps designed for heavy loads.',
      categorySlug: 'bags',
      collectionSlug: 'athlete-series',
      price: 4999,
      compareAtPrice: 5999,
      isFeatured: true,
      isNewArrival: true,
      isBestSeller: true,
      dimensions: '55cm x 33cm x 22cm',
      weightGrams: 1200,
      capacity: '40 Liters',
      materials: ['900D Water-Resistant Polyester', 'YKK Zippers', 'Reinforced Nylon Base', 'EVA Padded Back Panel'],
      tags: ['backpack', 'sport', 'training', 'gym', 'travel', 'athlete'],
      images: [
        { url: img('photo-1553062407-98eeb64c6a62?w=800&h=1000&fit=crop&q=80'), alt: 'Athlete 40L Backpack' },
        { url: img('photo-1622560480605-d83c853bc5c3?w=800&h=1000&fit=crop&q=80'), alt: 'Athlete 40L Backpack side' },
        { url: img('photo-1581605405669-fcdf81165b94?w=800&h=1000&fit=crop&q=80'), alt: 'Athlete 40L Backpack back' },
        { url: img('photo-1491637639811-60e2756cc1c7?w=800&h=1000&fit=crop&q=80'), alt: 'Athlete 40L Backpack detail' },
      ],
      features: [
        ['Dedicated Shoe Compartment', 'Ventilated bottom compartment keeps shoes separate from clean gear.', 'package'],
        ['Quick-Access Pocket', 'Top-access pocket for phone, keys, and essentials without opening main compartment.', null],
        ['Laptop Sleeve', 'Padded 15.6" laptop sleeve with soft-touch lining.', null],
        ['Water Bottle Pockets', 'Dual stretch mesh side pockets fit bottles up to 1L.', null],
        ['Compression Straps', 'External compression straps for volume control and load stability.', null],
        ['Key Leash', 'Built-in key clip in the front pocket for quick access.', null],
        ['Chest Strap', 'Adjustable chest strap distributes weight for long carries.', null],
        ['Hidden Security Pocket', 'Back-panel pocket against your back for valuables.', null],
      ],
      variants: [
        { sku: 'KIEN-ATH-40L-BLK', colorName: 'Matte Black', colorHex: '#1a1a1a', qty: 50 },
        { sku: 'KIEN-ATH-40L-GRA', colorName: 'Graphite', colorHex: '#3a3a3a', qty: 25 },
      ],
    },
    {
      slug: 'kien-duffel',
      name: 'KIEN Duffel Bag',
      shortDescription: 'Purpose-built for training. Separate. Organize. Move.',
      description:
        'The KIEN Duffel is the gym bag you actually want to carry. Purpose-built compartments for wet and dry separation, a dedicated shoe pocket, and enough room for a full training session. Designed for the daily athlete.',
      categorySlug: 'bags',
      collectionSlug: 'training-series',
      price: 3499,
      compareAtPrice: 3999,
      isFeatured: true,
      isNewArrival: true,
      isBestSeller: false,
      dimensions: '52cm x 28cm x 26cm',
      weightGrams: 850,
      capacity: '35 Liters',
      materials: ['600D Ripstop Nylon', 'YKK Zippers', 'TPE Waterproof Lining', 'Reinforced Handles'],
      tags: ['duffel', 'gym', 'training', 'sport', 'bag'],
      images: [
        { url: img('photo-1605733160314-4fc7dac4bb16?w=800&h=1000&fit=crop&q=80'), alt: 'KIEN Duffel Bag' },
        { url: img('photo-1553062407-98eeb64c6a62?w=800&h=1000&fit=crop&q=80'), alt: 'KIEN Duffel Bag detail' },
        { url: img('photo-1581605405669-fcdf81165b94?w=800&h=1000&fit=crop&q=80'), alt: 'KIEN Duffel Bag pocket' },
      ],
      features: [
        ['Wet/Dry Separation', 'Waterproof inner pocket separates wet towels and swimwear from dry gear.', null],
        ['Shoe Compartment', 'Side-access ventilated shoe pocket fits up to size 12.', null],
        ['U-Shaped Opening', 'Wide U-shaped main opening for easy packing and visibility.', null],
        ['Removable Shoulder Strap', 'Padded adjustable strap with anti-slip grip.', null],
        ['Inner Mesh Pockets', 'Multiple mesh organizer pockets for small items.', null],
        ['Reinforced Base', 'Hard-shell base protects contents when bag is placed down.', null],
      ],
      variants: [
        { sku: 'KIEN-DUF-35L-BLK', colorName: 'Matte Black', colorHex: '#1a1a1a', qty: 40 },
      ],
    },
    {
      slug: 'kien-lifestyle-sling',
      name: 'KIEN Lifestyle Sling Bag',
      shortDescription: 'Minimal carry for maximum freedom.',
      description:
        'The KIEN Lifestyle Sling is minimal carry at its most purposeful. Designed for the essentials: phone, wallet, keys, earbuds and not much else. Wear it crossbody or over one shoulder. From commute to weekend, it fits naturally into everyday life.',
      categorySlug: 'sling-bags',
      collectionSlug: 'everyday-series',
      price: 1999,
      compareAtPrice: 2499,
      isFeatured: true,
      isNewArrival: true,
      isBestSeller: false,
      dimensions: '32cm x 18cm x 8cm',
      weightGrams: 300,
      capacity: '4 Liters',
      materials: ['Coated 420D Nylon', 'SBS Zippers', 'Soft-Touch Lining', 'Nylon Webbing Strap'],
      tags: ['sling', 'lifestyle', 'everyday', 'minimal', 'crossbody'],
      images: [
        { url: img('photo-1548036328-c9fa89d128fa?w=800&h=1000&fit=crop&q=80'), alt: 'KIEN Lifestyle Sling Bag' },
        { url: img('photo-1622560480605-d83c853bc5c3?w=800&h=1000&fit=crop&q=80'), alt: 'KIEN Lifestyle Sling worn' },
        { url: img('photo-1553062407-98eeb64c6a62?w=800&h=1000&fit=crop&q=80'), alt: 'KIEN Lifestyle Sling detail' },
      ],
      features: [
        ['Quick-Access Front Pocket', 'Magnetic closure pocket for phone or transit card.', null],
        ['Main Compartment', 'Organized interior with card slots and key clip.', null],
        ['Hidden Back Pocket', 'Security pocket against your body for valuables.', null],
        ['Adjustable Strap', 'Single strap with quick-release buckle for crossbody or shoulder wear.', null],
        ['Water-Resistant Shell', 'Coated exterior repels light rain and splashes.', null],
      ],
      variants: [
        { sku: 'KIEN-SLG-4L-BLK', colorName: 'Matte Black', colorHex: '#1a1a1a', qty: 60 },
        { sku: 'KIEN-SLG-4L-STN', colorName: 'Stone', colorHex: '#a09080', qty: 30 },
      ],
    },
  ];

  for (const p of products) {
    const existing = await prisma.product.findUnique({ where: { slug: p.slug } });
    if (existing) {
      console.log('Product exists, skipping: ' + p.slug);
      continue;
    }
    await prisma.product.create({
      data: {
        slug: p.slug,
        name: p.name,
        shortDescription: p.shortDescription,
        description: p.description,
        status: 'ACTIVE',
        pricePaise: rupeesToPaise(p.price),
        compareAtPaise: p.compareAtPrice ? rupeesToPaise(p.compareAtPrice) : null,
        isFeatured: p.isFeatured,
        isNewArrival: p.isNewArrival,
        isBestSeller: p.isBestSeller,
        dimensions: p.dimensions,
        weightGrams: p.weightGrams,
        capacity: p.capacity,
        materials: p.materials,
        tags: p.tags,
        category: { connect: { slug: p.categorySlug } },
        collection: { connect: { slug: p.collectionSlug } },
        images: { create: p.images.map((i, idx) => ({ url: i.url, alt: i.alt, sortOrder: idx })) },
        features: {
          create: p.features.map(([title, description], idx) => ({ title, description, sortOrder: idx })),
        },
        variants: {
          create: p.variants.map((v) => ({
            sku: v.sku,
            colorName: v.colorName,
            colorHex: v.colorHex,
            inventory: { create: { availableQty: v.qty } },
          })),
        },
      },
    });
    console.log('Seeded product: ' + p.slug);
  }

  // Admin user - password must be supplied via env, never committed.
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const email = z.string().email().parse(adminEmail);
    if (adminPassword.length < 10) throw new Error('ADMIN_PASSWORD must be at least 10 characters');
    const existing = await prisma.user.findUnique({ where: { email } });
    if (!existing) {
      await prisma.user.create({
        data: {
          email,
          passwordHash: await bcrypt.hash(adminPassword, 12),
          firstName: 'KIEN',
          lastName: 'Admin',
          emailVerifiedAt: new Date(),
          roles: { create: { role: { connect: { name: 'ADMIN' } } } },
        },
      });
      console.log('Admin user created: ' + email);
    } else {
      console.log('Admin user already exists: ' + email);
    }
  } else {
    console.log('ADMIN_EMAIL / ADMIN_PASSWORD not set - skipped admin user creation');
  }
};

seed()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
