import dotenv from 'dotenv';

dotenv.config({
  path: '.env.test',
  override: true,
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required to run tests.');
}

let parsedDatabaseUrl: URL;

try {
  parsedDatabaseUrl = new URL(testDatabaseUrl);
} catch {
  throw new Error('TEST_DATABASE_URL is not a valid database URL.');
}

const databaseName = parsedDatabaseUrl.pathname.replace(/^\//, '');
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

if (databaseName !== 'kien_sports_test') {
  throw new Error(
    `Unsafe test database "${databaseName}". Expected "kien_sports_test".`,
  );
}

if (!allowedHosts.has(parsedDatabaseUrl.hostname)) {
  throw new Error(
    `Unsafe test database host "${parsedDatabaseUrl.hostname}". Local database required.`,
  );
}

process.env.DATABASE_URL = testDatabaseUrl;
process.env.NODE_ENV = 'test';

console.log('Test database safety check passed:', databaseName);
