const env = process.env;
export const config = {
  production: env.NODE_ENV === 'production',
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || '',
  // Background checks; tests turn them off and call them directly.
  jobs: env.STATUS_JOBS !== 'off',
};
