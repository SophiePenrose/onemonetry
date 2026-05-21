import { hasProcessedZipStore } from "./processed-zips.js";

export function getDailyAutoPullPlan(dailyFiles, options = {}) {
  const processedStoreExists = options.processedStoreExists ?? hasProcessedZipStore();
  const unprocessed = dailyFiles.filter((file) => !file.processed);

  if (unprocessed.length === 0) {
    return { filesToProcess: [], filesToBaseline: [], initializedBaseline: false };
  }

  if (!processedStoreExists) {
    return {
      filesToProcess: [],
      filesToBaseline: dailyFiles,
      initializedBaseline: true,
    };
  }

  return { filesToProcess: unprocessed, filesToBaseline: [], initializedBaseline: false };
}
