import { writeFileSync } from "node:fs";
import type { Reporter } from "vitest/reporters";

type FileTiming = {
  file: string;
  workerSetupMs: number;
  importAndCollectionMs: number;
  testAndHookMs: number;
};

type TestModule = Parameters<NonNullable<Reporter["onTestRunEnd"]>>[0][number];

const timingReportPath = process.env.INTEGRATION_TIMING_REPORT_PATH;

function toFileTiming(testModule: TestModule): FileTiming {
  const diagnostic = testModule.diagnostic();

  return {
    file: testModule.relativeModuleId,
    // Vitest measures these separately for each worker. They are summed by
    // the parent command as useful diagnostics, not presented as wall time.
    workerSetupMs:
      diagnostic.environmentSetupDuration +
      diagnostic.prepareDuration +
      diagnostic.setupDuration,
    importAndCollectionMs: diagnostic.collectDuration,
    testAndHookMs: diagnostic.duration,
  };
}

export default class IntegrationTimingReporter implements Reporter {
  onTestRunEnd(testModules: TestModule[]) {
    if (!timingReportPath) {
      return;
    }

    const files = testModules.map(toFileTiming);
    writeFileSync(
      timingReportPath,
      `${JSON.stringify({ files })}\n`,
      "utf8"
    );
  }
}