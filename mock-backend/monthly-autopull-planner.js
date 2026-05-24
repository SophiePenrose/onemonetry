export const MONTHLY_BACKFILL_FILE_COUNT = 24;

export function getMonthlyAutoPullPlan(monthlyFiles, options = {}) {
  const fileCount = options.fileCount ?? MONTHLY_BACKFILL_FILE_COUNT;
  const filesToCheck = monthlyFiles.slice(0, fileCount);

  return {
    filesToCheck,
    filesToProcess: filesToCheck.filter((file) => !file.processed),
  };
}
