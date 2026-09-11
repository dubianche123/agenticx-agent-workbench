import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { readBulkImportFile, type BulkImportFileLike } from "./bulk-import-file";

function fakeFile(name: string, bytes: ArrayBuffer | string): BulkImportFileLike {
  return {
    name,
    text: async () => (typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)),
    arrayBuffer: async () =>
      typeof bytes === "string" ? new TextEncoder().encode(bytes).buffer : bytes,
  };
}

function workbookBytes(
  sheets: Record<string, string[][]>,
  bookType: "xlsx" | "biff8" = "xlsx",
): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  }
  const bytes = XLSX.write(workbook, { type: "array", bookType });
  return bytes;
}

describe("readBulkImportFile", () => {
  it("keeps CSV text on the existing path", async () => {
    const result = await readBulkImportFile(
      fakeFile("members.csv", "姓名,电子邮件\nAlice,alice@example.com\n"),
    );

    expect(result).toEqual({
      text: "姓名,电子邮件\nAlice,alice@example.com\n",
      format: "csv",
    });
  });

  it("converts an XLSX sheet with Chinese headers to CSV-shaped text", async () => {
    const result = await readBulkImportFile(
      fakeFile(
        "通讯录.xlsx",
        workbookBytes({
          通讯录: [
            ["姓名", "编号", "部门", "电子邮件"],
            ["Alice", "E001", "研发", "alice@example.com"],
          ],
        }),
      ),
    );

    expect(result.format).toBe("spreadsheet");
    expect(result.sheetName).toBe("通讯录");
    expect(result.text).toContain("姓名,编号,部门,电子邮件");
    expect(result.text).toContain("Alice,E001,研发,alice@example.com");
  });

  it("skips an empty first sheet and uses the first non-empty sheet", async () => {
    const result = await readBulkImportFile(
      fakeFile(
        "members.xls",
        workbookBytes({
          Empty: [],
          Members: [["display_name", "email"], ["Bob", "bob@example.com"]],
        }, "biff8"),
      ),
    );

    expect(result.sheetName).toBe("Members");
    expect(result.text).toContain("display_name,email");
  });

  it("rejects unsupported files and empty workbooks", async () => {
    await expect(readBulkImportFile(fakeFile("members.txt", "text"))).rejects.toThrow(
      "仅支持 CSV、XLSX 或 XLS 文件",
    );
    await expect(
      readBulkImportFile(fakeFile("empty.xlsx", workbookBytes({ Empty: [] }))),
    ).rejects.toThrow("Excel 文件没有可导入的数据");
  });
});
