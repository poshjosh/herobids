import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentTool } from '@herobids/domain';
import { filesystemTools } from './filesystem.js';
import { webAccessTools } from './web-access.js';
import { FILE_TOOL_PARAMS, findSignatureProblems, toolCall, toolSignature } from './tool-signature.js';

/**
 * Tools whose parameters change in later work packages (see the plan). Until then the
 * static map describes the planned signature, so it cannot match the current schema.
 * The drift test below requires an entry to be REMOVED from this list as soon as the
 * tool's schema matches the map, so the guard cannot be forgotten.
 */
const NOT_YET_IMPLEMENTED = new Set([
  'read_file', // WP2: offset, limit
  'list_files', // WP2: offset, limit
  'delete_file', // WP4: recursive
  'browse_url', // WP6: limit
  'read_file_lines', // WP2
  'search_files', // WP5
  'append_file', // WP4
  'edit_file', // WP4
]);

function schemaSignature(tool: AgentTool): string {
  const schema = tool.parametersSchema;
  if (!(schema instanceof z.ZodObject)) throw new Error(`${tool.name}: expected a Zod object schema`);
  const params = Object.entries(schema.shape as Record<string, z.ZodTypeAny>)
    .map(([key, field]) => (field.isOptional() ? `${key}?` : key));
  return `${tool.name}(${params.join(', ')})`;
}

describe('toolSignature', () => {
  it('marks optional parameters with a question mark', () => {
    expect(toolSignature('read_file_lines')).toBe('read_file_lines(path, startLine?, limit?, maxChars?)');
  });

  it('throws for an unknown tool in tests', () => {
    expect(() => toolSignature('nope')).toThrow(/unknown tool/);
  });
});

describe('toolCall', () => {
  it('renders an example call with quoted strings', () => {
    expect(toolCall('read_file_lines', { path: 'jobs.json', startLine: 115, limit: 20 }))
      .toBe('read_file_lines(path: "jobs.json", startLine: 115, limit: 20)');
  });

  it('throws for an unknown tool or parameter in tests', () => {
    expect(() => toolCall('nope', {})).toThrow(/unknown tool/);
    expect(() => toolCall('read_file', { file: 'x' })).toThrow(/no parameter "file"/);
  });

  it('falls back to the bare name outside tests instead of throwing', () => {
    const nodeEnv = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'production';
      expect(toolCall('nope', {})).toBe('nope');
      expect(toolCall('read_file', { file: 'x' })).toBe('read_file');
      expect(toolSignature('nope')).toBe('nope');
    } finally {
      process.env['NODE_ENV'] = nodeEnv;
    }
  });
});

describe('signature drift', () => {
  const tools = new Map<string, AgentTool>([...filesystemTools, ...webAccessTools].map((t) => [t.name, t]));

  it.each(Object.keys(FILE_TOOL_PARAMS))('%s matches its real parameter schema', (name) => {
    const tool = tools.get(name);
    const matches = tool !== undefined && schemaSignature(tool) === toolSignature(name);
    if (NOT_YET_IMPLEMENTED.has(name)) {
      // Remove the tool from NOT_YET_IMPLEMENTED once its schema is implemented.
      expect(matches, `${name} now matches its schema: remove it from NOT_YET_IMPLEMENTED`).toBe(false);
    } else {
      expect(tool, `${name} must exist`).toBeDefined();
      expect(schemaSignature(tool!)).toBe(toolSignature(name));
    }
  });

  it('flags a signature in text that names a parameter the tool does not have', () => {
    expect(findSignatureProblems('Use read_file(path, offset?) or search_files(path, query).')).toEqual([]);
    expect(findSignatureProblems('read_file(path: "x", startLine: 3)')).toEqual([
      'read_file(path: "x", startLine: 3): unknown parameter "startLine"',
    ]);
  });
});
