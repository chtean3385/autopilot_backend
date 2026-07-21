// Centralized BACKEND_URL configuration
// Ensures unsubscribe links and other user-facing URLs work in production

function getBackendUrl() {
  let url = process.env.BACKEND_URL;

  if (!url) {
    // In production (NODE_ENV=production), fail hard instead of silently using localhost
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        '[Config] BACKEND_URL is not set in production environment. ' +
        'Set it to your production domain (e.g., https://api.resort-crm.com). ' +
        'Without it, unsubscribe links and other URLs will be broken.'
      );
    }
    // Development fallback
    url = `http://localhost:${process.env.PORT || 5000}`;
  }

  // Ensure no trailing slash for consistency
  return url.replace(/\/$/, '');
}

module.exports = { getBackendUrl };
