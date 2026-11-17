// The forge's server, as main.ts imports it: one process serving git smart HTTP, REST v3,
// GraphQL v4 and MCP from the one in-memory store (src/server.ts).

export { createApp } from './src/server.ts';
