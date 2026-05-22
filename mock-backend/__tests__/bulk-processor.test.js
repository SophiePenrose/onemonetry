import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMonthlyZipFileList, MONTHLY_BACKFILL_MONTHS } from "../bulk-processor.js";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function monthlyFile(year, month, prefix = "") {
  return `${prefix}Accounts_Monthly_Data-${MONTH_NAMES[month - 1]}${year}.zip`;
}

function monthlyRange(startYear, startMonth, endYear, endMonth, prefix = "") {
  const files = [];
  for (let year = startYear, month = startMonth; year < endYear || (year === endYear && month <= endMonth); month++) {
    if (month > 12) {
      year++;
      month = 1;
    }
    files.push(monthlyFile(year, month, prefix));
  }
  return files;
}

describe("monthly bulk ZIP discovery", () => {
  it("returns the latest 24 monthly files across current and historic listings", () => {
    const currentFiles = monthlyRange(2025, 4, 2026, 4);
    const archiveFiles = [
      monthlyFile(2024, 4, "archive/"),
      ...monthlyRange(2024, 5, 2024, 12, "archive/"),
      ...monthlyRange(2025, 1, 2025, 12),
    ];

    const files = buildMonthlyZipFileList(currentFiles, archiveFiles, {
      isProcessed: () => false,
    });

    assert.equal(files.length, MONTHLY_BACKFILL_MONTHS);
    assert.equal(files[0].period, "2026-04");
    assert.equal(files.at(-1).period, "2024-05");
    assert.equal(files.some((file) => file.period === "2024-04"), false);
  });

  it("deduplicates historic files in favor of current listings", () => {
    const currentFiles = [monthlyFile(2025, 4)];
    const archiveFiles = [monthlyFile(2025, 4), monthlyFile(2025, 3, "archive/")];

    const files = buildMonthlyZipFileList(currentFiles, archiveFiles, {
      isProcessed: (filename) => filename.includes("March2025"),
    });

    const april2025 = files.find((file) => file.period === "2025-04");
    const march2025 = files.find((file) => file.period === "2025-03");

    assert.equal(files.filter((file) => file.period === "2025-04").length, 1);
    assert.equal(april2025.source, "current");
    assert.equal(april2025.url, "https://download.companieshouse.gov.uk/Accounts_Monthly_Data-April2025.zip");
    assert.equal(march2025.source, "archive");
    assert.equal(march2025.url, "https://download.companieshouse.gov.uk/archive/Accounts_Monthly_Data-March2025.zip");
    assert.equal(march2025.processed, true);
  });
});
