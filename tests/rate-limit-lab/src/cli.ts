import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdownReport } from './report.js';
import { runScenario } from './scenario-runner.js';
import { getScenarioConfig, listScenarioIds } from './scenarios.js';
import type { ScenarioId } from './types.js';

interface CliOptions {
  scenarioIds: ScenarioId[];
  outputDir: string;
  writeReports: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const defaultOutputDir = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'docs/test-reports/rate-limit');
  const scenarioIds: ScenarioId[] = [];
  let outputDir = defaultOutputDir;
  let writeReports = true;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--scenario') {
      const scenarioId = argv[index + 1] as ScenarioId | undefined;
      if (!scenarioId) {
        throw new Error('Missing value after --scenario');
      }
      scenarioIds.push(scenarioId);
      index += 1;
      continue;
    }
    if (value === '--all') {
      scenarioIds.splice(0, scenarioIds.length, ...listScenarioIds());
      continue;
    }
    if (value === '--output-dir') {
      const dir = argv[index + 1];
      if (!dir) {
        throw new Error('Missing value after --output-dir');
      }
      outputDir = path.resolve(dir);
      index += 1;
      continue;
    }
    if (value === '--no-write') {
      writeReports = false;
      continue;
    }
  }

  return {
    scenarioIds: scenarioIds.length > 0 ? scenarioIds : listScenarioIds(),
    outputDir,
    writeReports,
  };
}

function formatFileName(runDateIso: string, scenarioId: ScenarioId): string {
  const safeTimestamp = runDateIso.replace(/[:]/g, '-');
  return `${safeTimestamp}-scenario-${scenarioId.toLowerCase()}.md`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.writeReports) {
    await mkdir(options.outputDir, { recursive: true });
  }

  for (const scenarioId of options.scenarioIds) {
    const config = getScenarioConfig(scenarioId);
    const result = await runScenario(config);
    const markdown = renderMarkdownReport(result);
    const fileName = formatFileName(result.runDateIso, scenarioId);
    const filePath = path.join(options.outputDir, fileName);

    if (options.writeReports) {
      await writeFile(filePath, markdown, 'utf8');
      console.log(`${scenarioId}: ${result.verdict} (${filePath})`);
    } else {
      console.log(markdown);
    }
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});