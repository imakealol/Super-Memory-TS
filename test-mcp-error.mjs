import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Create a minimal server to test
const server = new McpServer({ name: 'test', version: '1.0.0' });

// Register a test tool that throws "Bad Request"
server.registerTool('test_bad_request', {
  description: 'Test tool that throws Bad Request',
  inputSchema: {
    content: z.string().min(1),
  },
}, async ({ content }) => {
  // This mimics what add_memory does
  if (content === 'throw') {
    throw new Error('Bad Request');
  }
  return {
    content: [{ type: 'text', text: `Got: ${content}` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Keep the server running
await new Promise(() => {});