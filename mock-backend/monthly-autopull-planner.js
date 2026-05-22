export function getMonthlyAutoPullPlan(monthlyFiles) {
  return {
    filesToProcess: monthlyFiles.filter((file) => !file.processed),
  };
}
