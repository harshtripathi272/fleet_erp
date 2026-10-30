// Loaded before every test file (see the "test" script): fast password hashing, quiet logs.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.PASSWORD_HASH_COST = '10';
process.env.EXPOSE_RESET_TOKEN = 'true';
