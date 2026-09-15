import { useLayoutEffect, useState, type ReactNode } from "react";

interface ScannerPageControlsProps {
  summary: string;
  error: string;
  disabled: boolean;
  children: ReactNode;
}

/** Keep navigation/export settings available without taking space from the page. */
export function ScannerPageControls({ summary, error, disabled, children }: ScannerPageControlsProps) {
  const [expanded, setExpanded] = useState(Boolean(error));
  useLayoutEffect(() => { if (error) setExpanded(true); }, [error]);

  return <details className="scanner-pages-panel" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>
      <strong>Страницы и сохранение</strong>
      <span className="scanner-pages-summary">{summary}</span>
      {error && <span className="field-error" role="status">{error}</span>}
    </summary>
    <div className="scanner-pages-panel-content">
      <fieldset disabled={disabled} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>{children}</fieldset>
    </div>
  </details>;
}
