import { ScrollText } from "lucide-react";
import { LogsLive } from "@/components/logs-live";
import { PageHeader } from "@/components/page-header";
import { getServerLogger } from "@/lib/log/server-log";
import type { LogRecord } from "@/lib/log/types";

export const dynamic = "force-dynamic";

const INITIAL_LIMIT = 500;

// Global structured server-log view (issue #294, ADR 035). Complements the
// per-job SSE stream with a searchable, level-filterable, live-tailing view of
// server-level records. The initial window is rendered server-side; the client
// then opens the SSE tail.
export default function LogsPage() {
  let initial: LogRecord[] = [];
  let sinkLevel: LogRecord["level"] = "info";
  let logFile: string | null = null;
  try {
    const logger = getServerLogger();
    initial = logger.recent({ limit: INITIAL_LIMIT });
    const config = logger.getConfig();
    sinkLevel = config.level;
    logFile = config.file;
  } catch {
    // Logger unavailable on first boot — render an empty live view.
  }

  return (
    <div className="dd-fade-up">
      <PageHeader
        title="Logs"
        subtitle="Searchable, live-tailing view of structured server logs."
        icon={ScrollText}
      />
      <LogsLive initial={initial} sinkLevel={sinkLevel} logFile={logFile} />
    </div>
  );
}
