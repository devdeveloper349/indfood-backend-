/**
 * Centralized JWT Security Configuration
 * Guarantees consistent signing and verification across all controllers.
 * Strictly fails in production if JWT_SECRET is missing or insecure.
 */

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  const isProduction = process.env.NODE_ENV === 'production';

  if (!secret || secret.trim().length === 0) {
    if (isProduction) {
      throw new Error('Fatal Security Configuration Error: JWT_SECRET must be configured in production environment.');
    }
    // Safe dev/test fallback when not in production
    return 'indfood_dev_jwt_secret_key_2026';
  }

  if (isProduction && (secret.length < 32 || secret === 'secret' || secret === 'default')) {
    throw new Error('Fatal Security Configuration Error: Insecure JWT_SECRET detected in production environment.');
  }

  return secret;
}

module.exports = {
  getJwtSecret
};
