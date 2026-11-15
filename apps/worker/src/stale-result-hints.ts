import { staleReadHint, staleSearchHint } from './tools/file-messages.js';

export interface CutResultInfo {
  toolName: string | undefined;
  args: Record<string, unknown>;
  originalContent: string;
}

type HintBuilder = (info: CutResultInfo) => string | undefined;

/** The re-read hint comes from the original call, so it only needs a string `path`. */
const readHint: HintBuilder = ({ args }) => {
  const path = args['path'];
  return typeof path === 'string' && path.length > 0 ? staleReadHint(path) : undefined;
};

// The browse_url row is added with that tool (WP6).
const HINTS_BY_TOOL: Readonly<Record<string, HintBuilder>> = {
  read_file: readHint,
  read_file_lines: readHint,
  search_files: () => staleSearchHint(),
};

/** Hint for the cut marker of a stale tool result, or undefined when a re-read is not cheap. */
export function describeCutResult(info: CutResultInfo): string | undefined {
  if (info.toolName === undefined) return undefined;
  return HINTS_BY_TOOL[info.toolName]?.(info);
}
