/**
 * Body limit for routes that proxy LLM completion payloads (gateway `/v1/*`,
 * chat message turns). Base64-encoded images inflate 4/3 — an 8 MiB image is
 * ~10.7 MB of JSON, and one request may carry several. Fastify's 1 MiB
 * default rejects those before the handler runs, closing the socket
 * mid-upload: clients observe EPIPE instead of a status code.
 */
export const PROXY_BODY_LIMIT_BYTES = 48 * 1024 * 1024;
