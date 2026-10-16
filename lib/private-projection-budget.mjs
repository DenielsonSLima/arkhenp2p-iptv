// The SQL functions retain an 8s statement budget. HTTP must allow that query
// to finish plus transport/JSON time instead of cancelling it after 3s.
// Scoped only to Home and movie recommendations, not provider/media requests.
export const PRIVATE_PROJECTION_TIMEOUT_MS=10000;
