import * as XLSX from "xlsx";

export type BulkImportFileLike = {
  name: string;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export type BulkImportFileReadResult = {
  text: string;
  format: "csv" | "spreadsheet";
  sheetName?: string;
};

const SPREADSHEET_EXTENSIONS = new Set(["xlsx", "xls"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Read an admin member-import file into the CSV-shaped text consumed by the
 * existing column mapping/precheck flow. Excel files are parsed locally; the
 * original workbook is never sent to the server.
 */
export async function readBulkImportFile(
  file: BulkImportFileLike,
): Promise<BulkImportFileReadResult> {
  const extension = extensionOf(file.name);
  if (extension === "csv") {
    return { text: await file.text(), format: "csv" };
  }

  if (!SPREADSHEET_EXTENSIONS.has(extension)) {
    throw new Error("仅支持 CSV、XLSX 或 XLS 文件");
  }

  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheetName = workbook.SheetNames.find((name) => {
    const sheet = workbook.Sheets[name];
    return Boolean(sheet && XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim());
  });
  if (!sheetName) {
    throw new Error("Excel 文件没有可导入的数据");
  }

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error("Excel 文件没有可导入的数据");
  }
  const text = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
  if (!text.trim()) {
    throw new Error("Excel 文件没有可导入的数据");
  }

  return { text, format: "spreadsheet", sheetName };
}
