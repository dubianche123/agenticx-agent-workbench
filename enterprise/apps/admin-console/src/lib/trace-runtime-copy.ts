export type TraceRuntimeCopy = {
  portalLogs: string;
  portalLogsUnavailable: string;
  portalLogsUnavailableDescription: string;
  gatewayAudit: string;
  modelSteps: string;
  fallbackDescription: string;
  viewRunRecords: string;
};

/**
 * Copy for the source badges that are also used in trace fallback states.
 * Kept beside the admin UI because the shared trace contract is not locale-aware.
 */
export function getTraceRuntimeCopy(locale: string): TraceRuntimeCopy {
  if (locale.toLowerCase().startsWith("zh")) {
    return {
      portalLogs: "Portal 行为日志",
      portalLogsUnavailable: "Portal 行为日志源不可用",
      portalLogsUnavailableDescription: "Portal 行为日志源不可用，以下为已落库的网关审计与模型 Trace。",
      gatewayAudit: "网关审计",
      modelSteps: "模型 Trace",
      fallbackDescription: "Portal 行为日志未采集，以下为已落库的网关审计与模型 Trace。",
      viewRunRecords: "查看运行记录",
    };
  }
  return {
    portalLogs: "Portal behavior logs",
    portalLogsUnavailable: "Portal behavior log source unavailable",
    portalLogsUnavailableDescription:
      "The Portal behavior log source is unavailable; the data below comes from persisted gateway audit and model Trace records.",
    gatewayAudit: "Gateway audit",
    modelSteps: "Model Trace",
    fallbackDescription:
      "Portal behavior logs were not collected; the data below comes from persisted gateway audit and model Trace records.",
    viewRunRecords: "View run records",
  };
}
