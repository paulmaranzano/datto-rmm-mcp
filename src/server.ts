import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { allTools } from './tools/index.js';
import { staticResources, resourceTemplates, handleResource } from './resources.js';
import {
  DESTRUCTIVE_TOOLS,
  CONFIRM_REQUIRED_TOOLS,
  confirmTokenFor,
  isReadonly,
} from './security.js';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'),
) as { version: string };

export interface BuiltServer {
  server: McpServer;
  readonly: boolean;
  registeredCount: number;
  skippedDestructive: number;
}

// Builds a fully registered MCP server. stdio builds one; HTTP builds one per request (stateless).
// The Datto API client is a module singleton, so the OAuth token is shared across servers.
export function buildServer(): BuiltServer {
  const server = new McpServer({
    name: 'datto-rmm-mcp-server',
    version: pkg.version,
  });

  const readonly = isReadonly();
  let registeredCount = 0;
  let skippedDestructive = 0;

  for (const tool of allTools) {
    const isDestructive = DESTRUCTIVE_TOOLS.has(tool.name);
    const requiresConfirm = CONFIRM_REQUIRED_TOOLS.has(tool.name);
    if (readonly && isDestructive) {
      skippedDestructive++;
      continue;
    }

    const confirmToken = requiresConfirm ? confirmTokenFor(tool.name) : null;

    const shape: Record<string, z.ZodTypeAny> = {};
    const props = tool.inputSchema.properties;
    const required = tool.inputSchema.required || [];

    if (confirmToken) {
      shape.confirm = z
        .string()
        .describe(
          `Required confirmation token. Must equal "${confirmToken}" to authorize this destructive action.`,
        );
    }

    for (const [key, prop] of Object.entries(props)) {
      let zodType: z.ZodTypeAny = z.string().describe(prop.description);
      if (!required.includes(key)) {
        zodType = zodType.optional();
      }
      shape[key] = zodType;
    }

    server.tool(tool.name, tool.description, shape, async (args: Record<string, unknown>) => {
      try {
        const stringArgs: Record<string, string> = {};
        for (const [k, v] of Object.entries(args)) {
          if (v !== undefined) stringArgs[k] = String(v);
        }

        if (confirmToken) {
          const given = stringArgs.confirm;
          if (given !== confirmToken) {
            throw new Error(
              `Destructive tool "${tool.name}" requires confirm: "${confirmToken}" (got: ${
                given ? `"${given}"` : 'missing'
              })`,
            );
          }
          delete stringArgs.confirm;
        }

        const result = await tool.handler(stringArgs);
        return { ...result } as {
          content: Array<{ type: 'text'; text: string }>;
          isError?: boolean;
          [key: string]: unknown;
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        } as {
          content: Array<{ type: 'text'; text: string }>;
          isError: boolean;
          [key: string]: unknown;
        };
      }
    });

    registeredCount++;
  }

  // Register static resources
  for (const res of staticResources) {
    server.resource(
      res.name,
      res.uri,
      { description: res.description, mimeType: res.mimeType },
      async (uri) => {
        const text = await handleResource(uri.href);
        return { contents: [{ uri: uri.href, mimeType: res.mimeType, text }] };
      },
    );
  }

  // Register resource templates
  for (const tpl of resourceTemplates) {
    server.resource(
      tpl.name,
      tpl.uriTemplate,
      { description: tpl.description, mimeType: tpl.mimeType },
      async (uri) => {
        const text = await handleResource(uri.href);
        return { contents: [{ uri: uri.href, mimeType: tpl.mimeType, text }] };
      },
    );
  }

  return { server, readonly, registeredCount, skippedDestructive };
}
